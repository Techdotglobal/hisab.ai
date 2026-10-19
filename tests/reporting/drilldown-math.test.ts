import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CanonicalAccountType, NormalBalance } from '../../src/lib/accounting/types'
import {
  METRICS,
  arithmeticLine,
  buildExplanation,
  contributionToMetric,
  describeOrigin,
  formatMoney,
  lineSignedAmount,
  reconcile,
  type MetricDef,
} from '../../src/lib/reporting/drilldown-math'

type Acct = { canonicalType: CanonicalAccountType; normalBalance: NormalBalance }
const A: Record<string, Acct> = {
  cash: { canonicalType: 'Asset', normalBalance: 'DEBIT' },
  ar: { canonicalType: 'Asset', normalBalance: 'DEBIT' },
  vatIn: { canonicalType: 'Asset', normalBalance: 'DEBIT' },
  ap: { canonicalType: 'Liability', normalBalance: 'CREDIT' },
  vatOut: { canonicalType: 'Liability', normalBalance: 'CREDIT' },
  revenue: { canonicalType: 'Income', normalBalance: 'CREDIT' },
  cogs: { canonicalType: 'CostOfGoodsSold', normalBalance: 'DEBIT' },
  opex: { canonicalType: 'Expense', normalBalance: 'DEBIT' },
}
interface Line { acct: keyof typeof A; debit: number; credit: number; doc: string }

// An illustrative ledger. Each document posts a balanced entry.
const ledger: Line[] = [
  // Invoice INV-1: 1,000 + 15% VAT
  { acct: 'ar', debit: 1150, credit: 0, doc: 'INV-1' },
  { acct: 'revenue', debit: 0, credit: 1000, doc: 'INV-1' },
  { acct: 'vatOut', debit: 0, credit: 150, doc: 'INV-1' },
  // Receipt of payment for INV-1: cash/AR only — must NOT add revenue
  { acct: 'cash', debit: 1150, credit: 0, doc: 'PAY-1' },
  { acct: 'ar', debit: 0, credit: 1150, doc: 'PAY-1' },
  // Bill B-1: 12,000 + 15% VAT
  { acct: 'opex', debit: 12000, credit: 0, doc: 'B-1' },
  { acct: 'vatIn', debit: 1800, credit: 0, doc: 'B-1' },
  { acct: 'ap', debit: 0, credit: 13800, doc: 'B-1' },
  // Payment of B-1 — must NOT add expense
  { acct: 'ap', debit: 13800, credit: 0, doc: 'PAY-2' },
  { acct: 'cash', debit: 0, credit: 13800, doc: 'PAY-2' },
  // Expense E-1: 4,500 paid in cash
  { acct: 'opex', debit: 4500, credit: 0, doc: 'E-1' },
  { acct: 'cash', debit: 0, credit: 4500, doc: 'E-1' },
  // COGS entry
  { acct: 'cogs', debit: 300, credit: 0, doc: 'J-1' },
  { acct: 'cash', debit: 0, credit: 300, doc: 'J-1' },
]

function total(metric: MetricDef, lines: Line[]): number {
  return Math.round(lines.reduce((s, l) => s + contributionToMetric(metric, { ...A[l.acct], debit: l.debit, credit: l.credit }), 0) * 100) / 100
}

describe('metric contributions over a posted ledger', () => {
  it('every document entry balances', () => {
    for (const doc of new Set(ledger.map((l) => l.doc))) {
      const rows = ledger.filter((l) => l.doc === doc)
      assert.equal(rows.reduce((s, l) => s + l.debit, 0), rows.reduce((s, l) => s + l.credit, 0), doc)
    }
  })
  it('revenue excludes VAT and is not increased by the payment', () => {
    assert.equal(total(METRICS['pl.revenue'], ledger), 1000)
  })
  it('operating expenses exclude VAT and are not increased by paying the bill', () => {
    assert.equal(total(METRICS['pl.expenses'], ledger), 16500) // 12,000 + 4,500
  })
  it('gross and net profit combine the signed components', () => {
    assert.equal(total(METRICS['pl.gross_profit'], ledger), 700)
    assert.equal(total(METRICS['pl.net_profit'], ledger), -15800)
  })
  it('balance-sheet equation holds: equity includes unclosed earnings', () => {
    const assets = total(METRICS['bs.assets'], ledger)
    const liabilities = total(METRICS['bs.liabilities'], ledger)
    const equity = total(METRICS['bs.equity'], ledger)
    assert.equal(equity, total(METRICS['pl.net_profit'], ledger)) // no booked equity in this ledger
    assert.equal(Math.round((assets - liabilities - equity) * 100) / 100, 0)
  })
  it('a reversal offsets the original so the net figure is correct', () => {
    const reversed: Line[] = [
      ...ledger,
      { acct: 'revenue', debit: 1000, credit: 0, doc: 'REV-INV-1' },
      { acct: 'vatOut', debit: 150, credit: 0, doc: 'REV-INV-1' },
      { acct: 'ar', debit: 0, credit: 1150, doc: 'REV-INV-1' },
    ]
    assert.equal(total(METRICS['pl.revenue'], reversed), 0)
  })
  it('lines on accounts outside the metric contribute nothing', () => {
    assert.equal(contributionToMetric(METRICS['pl.revenue'], { ...A.cash, debit: 500, credit: 0 }), 0)
  })
  it('per-account figure follows the account normal balance', () => {
    assert.equal(lineSignedAmount(0, 1000, 'CREDIT'), 1000)
    assert.equal(lineSignedAmount(300, 0, 'DEBIT'), 300)
    assert.equal(lineSignedAmount(0, 50, 'DEBIT'), -50)
  })
})

describe('reconciliation', () => {
  it('reconciles when the listed lines add up to the report figure', () => {
    assert.deepEqual(reconcile(16500, 16500), { difference: 0, status: 'RECONCILED' })
    assert.equal(reconcile(16500.004, 16500).status, 'RECONCILED')
  })
  it('reports an honest difference instead of adjusting the figure', () => {
    assert.deepEqual(reconcile(16500, 16000), { difference: 500, status: 'DIFFERENCE' })
  })
})

describe('explanations', () => {
  it('shows the worked arithmetic from the actual amounts', () => {
    assert.equal(arithmeticLine([8000, 12000, 4500], 24500), '8,000.00 + 12,000.00 + 4,500.00 = SAR 24,500.00')
    assert.equal(arithmeticLine([100, -40], 60), '100.00 − 40.00 = SAR 60.00')
    assert.match(arithmeticLine(Array(20).fill(1), 20), /^Σ of 20 lines = SAR 20.00$/)
    assert.match(arithmeticLine([], 0), /No contributing lines/)
  })
  it('states rules, filters and limitations', () => {
    const e = buildExplanation({
      metric: METRICS['pl.expenses'], from: '2026-01-01', to: '2026-03-31', currency: 'SAR',
      costCenterLabel: 'Operations', amounts: [12000, 4500], includedTotal: 16500, reportTotal: 16000,
      excludedDrafts: 3, missingSource: 1, recon: reconcile(16000, 16500),
    })
    const text = e.steps.join('\n')
    assert.match(text, /POSTED only/)
    assert.match(text, /Operations/)
    assert.match(text, /VAT is posted to its own tax account/)
    assert.equal(e.limitations.length, 3)
    assert.match(e.limitations[0], /3 draft/)
    assert.match(e.summary, /Operating expenses = SAR 16,000.00/)
  })
  it('does not fabricate an origin for manual journals', () => {
    assert.equal(describeOrigin({ sourceType: 'JOURNAL', sourceId: null, journalEntryId: 'j1', sourceRef: null }), 'Manual journal entry (no source document)')
    assert.equal(describeOrigin({ sourceType: 'INVOICE', sourceId: 'x', journalEntryId: null, sourceRef: 'Invoice INV-9' }), 'Invoice INV-9')
    assert.equal(describeOrigin({ sourceType: 'INVOICE', sourceId: null, journalEntryId: null, sourceRef: null }), 'Origin not recorded')
    assert.equal(describeOrigin({ sourceType: 'BILL', sourceId: 'gone', journalEntryId: null, sourceRef: null }), 'Source document not found')
  })
  it('formats negatives with a true minus sign', () => {
    assert.equal(formatMoney(-1234.5), '−SAR 1,234.50')
  })
})

import { groupByDepartment } from '../../src/lib/reporting/drilldown-math'

describe('department grouping', () => {
  it('keeps unassigned lines in their own bucket and reconciles to the company total', () => {
    const lines = [
      { costCenterId: 'ops', amount: 8000 },
      { costCenterId: 'ops', amount: 500 },
      { costCenterId: 'hr', amount: 4500 },
      { costCenterId: null, amount: 12000 },
    ]
    const groups = groupByDepartment(lines)
    assert.equal(groups.find((g) => g.costCenterId === null)!.total, 12000)
    assert.equal(groups.find((g) => g.costCenterId === 'ops')!.total, 8500)
    const company = lines.reduce((s, l) => s + l.amount, 0)
    assert.equal(reconcile(company, groups.reduce((s, g) => s + g.total, 0)).status, 'RECONCILED')
  })
})
