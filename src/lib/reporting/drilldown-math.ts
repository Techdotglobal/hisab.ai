/**
 * Pure helpers behind the financial drill-down: which accounts a metric covers, how a ledger line
 * contributes to it, reconciliation against the report figure, and the plain-language
 * "How was this calculated?" explanation. No I/O — everything here is unit-tested.
 *
 * Source of truth: `ledger_entries`, which only ever contains POSTED journal lines. Reports and
 * drill-downs both read it, so drafts are excluded by construction and an invoice, its journal and
 * its later payment are never added together as separate "sources": revenue/expense come only from
 * the income/expense account lines, while a payment touches cash and receivable/payable accounts.
 */

import type { CanonicalAccountType, NormalBalance } from '@/lib/accounting/types'

export type MetricKey =
  | 'pl.revenue'
  | 'pl.cogs'
  | 'pl.expenses'
  | 'pl.gross_profit'
  | 'pl.net_profit'
  | 'bs.assets'
  | 'bs.liabilities'
  | 'bs.equity'
  | 'bs.earnings'
  | 'account'

export interface MetricDef {
  key: MetricKey
  label: string
  /** period = activity between from/to; asof = cumulative balance up to a date. */
  kind: 'period' | 'asof'
  /** Account types included and the sign each carries in the displayed figure. */
  types: Array<{ type: CanonicalAccountType; sign: 1 | -1 }>
  formula: string
}

export const METRICS: Record<Exclude<MetricKey, 'account'>, MetricDef> = {
  'pl.revenue': { key: 'pl.revenue', label: 'Revenue', kind: 'period', types: [{ type: 'Income', sign: 1 }], formula: 'Σ (credits − debits) on Income accounts' },
  'pl.cogs': { key: 'pl.cogs', label: 'Cost of goods sold', kind: 'period', types: [{ type: 'CostOfGoodsSold', sign: 1 }], formula: 'Σ (debits − credits) on Cost of Goods Sold accounts' },
  'pl.expenses': { key: 'pl.expenses', label: 'Operating expenses', kind: 'period', types: [{ type: 'Expense', sign: 1 }], formula: 'Σ (debits − credits) on Expense accounts' },
  'pl.gross_profit': { key: 'pl.gross_profit', label: 'Gross profit', kind: 'period', types: [{ type: 'Income', sign: 1 }, { type: 'CostOfGoodsSold', sign: -1 }], formula: 'Revenue − Cost of goods sold' },
  'pl.net_profit': { key: 'pl.net_profit', label: 'Net profit', kind: 'period', types: [{ type: 'Income', sign: 1 }, { type: 'CostOfGoodsSold', sign: -1 }, { type: 'Expense', sign: -1 }], formula: 'Revenue − Cost of goods sold − Operating expenses' },
  'bs.assets': { key: 'bs.assets', label: 'Total assets', kind: 'asof', types: [{ type: 'Asset', sign: 1 }], formula: 'Σ (debits − credits) on Asset accounts up to the as-of date' },
  'bs.liabilities': { key: 'bs.liabilities', label: 'Total liabilities', kind: 'asof', types: [{ type: 'Liability', sign: 1 }], formula: 'Σ (credits − debits) on Liability accounts up to the as-of date' },
  'bs.earnings': { key: 'bs.earnings', label: 'Current period earnings (not yet closed)', kind: 'asof', types: [{ type: 'Income', sign: 1 }, { type: 'CostOfGoodsSold', sign: -1 }, { type: 'Expense', sign: -1 }], formula: 'Income − Cost of goods sold − Expenses, cumulative up to the as-of date (closed years net to zero)' },
  'bs.equity': { key: 'bs.equity', label: 'Total equity', kind: 'asof', types: [{ type: 'Equity', sign: 1 }, { type: 'Income', sign: 1 }, { type: 'CostOfGoodsSold', sign: -1 }, { type: 'Expense', sign: -1 }], formula: 'Σ (credits − debits) on Equity accounts, plus unclosed earnings (Income − Cost of goods sold − Expenses) up to the as-of date' },
}

export function isMetricKey(value: unknown): value is MetricKey {
  return value === 'account' || (typeof value === 'string' && value in METRICS)
}

/** Amount a ledger line contributes to the signed balance of its own account (normal-balance aware). */
export function lineSignedAmount(debit: number, credit: number, normalBalance: NormalBalance): number {
  const net = debit - credit
  return normalBalance === 'DEBIT' ? net : -net
}

/** Amount a ledger line contributes to the metric (account sign × metric sign for its type). */
export function contributionToMetric(
  metric: MetricDef,
  line: { debit: number; credit: number; canonicalType: CanonicalAccountType; normalBalance: NormalBalance },
): number {
  const rule = metric.types.find((t) => t.type === line.canonicalType)
  if (!rule) return 0
  return round2(rule.sign * lineSignedAmount(line.debit, line.credit, line.normalBalance))
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export type ReconciliationStatus = 'RECONCILED' | 'DIFFERENCE'

export function reconcile(reportTotal: number, includedTotal: number): { difference: number; status: ReconciliationStatus } {
  const difference = round2(reportTotal - includedTotal)
  return { difference, status: Math.abs(difference) < 0.01 ? 'RECONCILED' : 'DIFFERENCE' }
}

export function formatMoney(n: number, currency = 'SAR'): string {
  const abs = Math.abs(round2(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? '−' : ''}${currency} ${abs}`
}

/** "8,000.00 + 12,000.00 − 500.00 = SAR 19,500.00", collapsing long lists to a Σ form. */
export function arithmeticLine(amounts: number[], total: number, currency = 'SAR', maxTerms = 12): string {
  if (amounts.length === 0) return `No contributing lines = ${formatMoney(0, currency)}`
  if (amounts.length > maxTerms) return `Σ of ${amounts.length} lines = ${formatMoney(total, currency)}`
  const fmt = (n: number) => Math.abs(round2(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const expr = amounts.map((a, i) => (i === 0 ? `${a < 0 ? '−' : ''}${fmt(a)}` : `${a < 0 ? '−' : '+'} ${fmt(a)}`)).join(' ')
  return `${expr} = ${formatMoney(total, currency)}`
}

export interface ExplanationInput {
  metric: MetricDef
  accountLabel?: string | null
  from?: string | null
  to?: string | null
  asOf?: string | null
  costCenterLabel?: string | null
  currency: string
  amounts: number[]
  includedTotal: number
  reportTotal: number
  excludedDrafts: number
  missingSource: number
  recon: { difference: number; status: ReconciliationStatus }
}

export interface Explanation {
  summary: string
  steps: string[]
  arithmetic: string
  limitations: string[]
}

export function buildExplanation(i: ExplanationInput): Explanation {
  const period =
    i.metric.kind === 'period'
      ? `from ${i.from ?? 'the start'} to ${i.to ?? 'today'} (inclusive, by posting-line entry date)`
      : `up to and including ${i.asOf ?? i.to ?? 'today'}, cumulative from the first posted entry`
  const steps = [
    `Source records: posted ledger lines (ledger entries). A journal line, or an invoice/bill/expense/payment, reaches the ledger only when it is posted.`,
    `Date range: ${period}.`,
    i.metric.key === 'account'
      ? `Accounts considered: ${i.accountLabel ?? 'the selected account'} only.`
      : `Accounts considered: every ${i.metric.types.map((t) => t.type).join(' / ')} account (header and deleted accounts are skipped, as in the report).`,
    `Filters: ${i.costCenterLabel ? `cost center / department = ${i.costCenterLabel}` : 'none (all departments and cost centers, including unassigned lines)'}.`,
    `Statuses included: POSTED only. Excluded: drafts and anything not yet posted. Reversed entries are included — the reversal is its own posted line that offsets the original, so the net figure stays correct.`,
    `Amount field: each line's debit and credit. ${i.metric.formula}. Debit-normal accounts (assets, expenses, COGS) count debits − credits; credit-normal accounts (liabilities, equity, income) count credits − debits.`,
    `Tax: VAT is posted to its own tax account, so it is not mixed into revenue or expense accounts — a line's "Subtotal / Tax / Total" columns describe the source document, while "Amount included" is what this specific figure takes from it.`,
    `Payments and adjustments: a payment moves cash and receivable/payable accounts; it does not create revenue or expense again. Adjustments and reversals are included as their own posted lines.`,
    `Aggregation: sum of "Amount included" over ${i.amounts.length} line${i.amounts.length === 1 ? '' : 's'}.`,
  ]
  const limitations: string[] = []
  if (i.excludedDrafts > 0) limitations.push(`${i.excludedDrafts} draft or unposted record(s) in this period are not included, by design.`)
  if (i.missingSource > 0) limitations.push(`${i.missingSource} ledger line(s) have no linked source document or journal entry; they are shown as "Origin not recorded" rather than guessed.`)
  if (i.recon.status === 'DIFFERENCE') {
    limitations.push(`The listed lines differ from the report figure by ${formatMoney(i.recon.difference, i.currency)}. This should not happen — check for lines on deleted or header accounts, or for entries posted while this view was loading.`)
  }
  return {
    summary: `${i.metric.key === 'account' ? i.accountLabel ?? 'Account' : i.metric.label} = ${formatMoney(i.reportTotal, i.currency)}`,
    steps,
    arithmetic: arithmeticLine(i.amounts, i.includedTotal, i.currency),
    limitations,
  }
}

/** Where a drill-down row's source comes from, without inventing a document when none exists. */
export function describeOrigin(row: { sourceType: string; sourceId: string | null; journalEntryId: string | null; sourceRef: string | null }): string {
  if (row.sourceRef) return row.sourceRef
  if (row.sourceType === 'JOURNAL' && row.journalEntryId) return 'Manual journal entry (no source document)'
  if (row.sourceType === 'OPENING_BALANCE') return 'Opening balance'
  if (!row.sourceId && !row.journalEntryId) return 'Origin not recorded'
  return 'Source document not found'
}

export interface DepartmentLine { costCenterId: string | null; amount: number }
export interface DepartmentTotal { costCenterId: string | null; total: number; lines: number }

/**
 * Groups metric contributions by department/cost center. Lines with no cost center form an explicit
 * "unassigned" bucket (costCenterId = null) — they are never folded into a department. Because every
 * line lands in exactly one bucket, the buckets always add up to the company-level figure.
 */
export function groupByDepartment(lines: DepartmentLine[]): DepartmentTotal[] {
  const map = new Map<string | null, DepartmentTotal>()
  for (const l of lines) {
    const cur = map.get(l.costCenterId) ?? { costCenterId: l.costCenterId, total: 0, lines: 0 }
    cur.total = round2(cur.total + l.amount)
    cur.lines += 1
    map.set(l.costCenterId, cur)
  }
  return [...map.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
}
