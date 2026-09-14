/**
 * Regression for the NETKOM Expenses negative-line-amount bug (QBO Expenses
 * 3258, 2863, 3637) — the same class of defect fixed for Bills
 * (quickbooks-bills-negative-lines.test.ts), never ported to Expenses.
 *
 * Root cause: QuickBooks permits an Expense's `AccountBasedExpenseLineDetail`
 * line to carry a negative `Amount` — an in-document reduction against the
 * same account (QBO's own reported expense total is already net of it). The
 * adapter passed this negative value through unchanged into
 * `expense_lines.amount`, which violates `expense_lines_amount_nonneg_chk`
 * (`010_database_hardening.sql`) — Postgres error `23514`. Unlike bill_lines,
 * expense_lines has no `unit_price` column, so only `amount` needed fixing.
 *
 * The fix stores the line's magnitude (`Math.abs`) and a new
 * `expense_lines.is_reduction` flag (migration 073) records that it posts as
 * a CREDIT (reducing the account) rather than a DEBIT in `postExpenseToLedger`
 * — preserving the original accounting direction instead of flipping a
 * reduction into a larger debit.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-expenses-negative-lines.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://expenses-negative-lines-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const { postExpenseToLedger } = requireModule('../../src/lib/accounting/document-posting') as typeof import('../../src/lib/accounting/document-posting')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')
const expensesModule = transactionModuleMap.get('expenses')!

const COMPANY = '33333333-3333-3333-3333-333333333333'

const db = {
  companies: [{ id: COMPANY, currency: 'SAR', reporting_currency: 'SAR' }],
  chart_of_accounts: [
    { id: 'acct-expense', company_id: COMPANY, account_no: '61-6101', name: 'Operating Expenses', canonical_type: 'Expense', is_active: true, deleted_at: null },
    { id: 'acct-bank', company_id: COMPANY, account_no: '11-1101-01', name: 'Cash and Bank', canonical_type: 'Asset', is_active: true, deleted_at: null },
  ],
  expenses: [] as Record<string, unknown>[],
  expense_lines: [] as Record<string, unknown>[],
  ledger_entries: [] as Record<string, unknown>[],
  reset() { this.expenses = []; this.expense_lines = []; this.ledger_entries = [] },
}

function eq(url: URL, name: string): string | null {
  const v = url.searchParams.get(name)
  return v?.startsWith('eq.') ? v.slice(3) : null
}
function ilikePrefix(url: URL, name: string): string | null {
  const v = url.searchParams.get(name)
  if (!v?.startsWith('ilike.')) return null
  return v.slice(6).replace(/%$/, '')
}

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (table === 'companies' && method === 'GET') {
      const id = eq(url, 'id')
      return json(db.companies.find((c) => c.id === id) ?? null)
    }
    if (table === 'chart_of_accounts' && method === 'GET') {
      let matches = db.chart_of_accounts.filter((a) => a.company_id === eq(url, 'company_id'))
      const prefix = ilikePrefix(url, 'account_no')
      const canonicalType = eq(url, 'canonical_type')
      const nameIlike = ilikePrefix(url, 'name')
      if (prefix) matches = matches.filter((a) => a.account_no.startsWith(prefix))
      if (canonicalType) matches = matches.filter((a) => a.canonical_type === canonicalType)
      if (nameIlike) matches = matches.filter((a) => a.name.toLowerCase().includes(nameIlike.toLowerCase()))
      return json(matches)
    }
    if (table === 'expenses') {
      if (method === 'GET') {
        const isEmbed = (url.searchParams.get('select') ?? '').includes('expense_lines')
        const id = eq(url, 'id')
        const row = db.expenses.find((e) => e.id === id)
        if (!row) return json(null)
        if (isEmbed) return json({ ...row, lines: db.expense_lines.filter((l) => l.expense_id === id) })
        return json(row)
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        const row = { id: randomUUID(), status: 'RECEIVED', ...body }
        db.expenses.push(row)
        return json(row, 201)
      }
      if (method === 'PATCH') {
        const id = eq(url, 'id')
        const row = db.expenses.find((e) => e.id === id)
        if (row) Object.assign(row, JSON.parse(String(init?.body ?? '{}')))
        return json(row)
      }
    }
    if (table === 'expense_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>[]
      const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: randomUUID(), ...r }))
      db.expense_lines.push(...rows)
      return json(rows, 201)
    }
    if (table === 'ledger_entries') {
      if (method === 'GET') return json([])
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>[]
        const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: randomUUID(), ...r }))
        db.ledger_entries.push(...rows)
        return json(rows, 201)
      }
    }
    if (table === 'rpc/post_source_document_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_company_id: string; p_source_type: string; p_source_id: string; p_lines: Record<string, unknown>[] }
      for (const line of body.p_lines) {
        db.ledger_entries.push({ id: randomUUID(), company_id: body.p_company_id, source_type: body.p_source_type, source_id: body.p_source_id, posting_sequence: db.ledger_entries.length + 1, ...line })
      }
      return json(db.ledger_entries.length, 200)
    }
    if (table === 'rpc/log_posting_audit' || table.startsWith('rpc/')) {
      if (method === 'POST') return json(null, 200)
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => db.reset())

/** Mirrors the mapped-row shape `quickbooks.adapter.ts` produces for an Expense. */
function expenseRow(transactionNo: string, lines: Array<{ amount: number; description?: string }>) {
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0)
  return {
    transactionNo, status: 'APPROVED', currency: 'SAR',
    total: subtotal, taxAmount: 0,
    lines: JSON.stringify(lines.map((l, i) => ({ sourceLineId: String(i + 1), detailType: 'AccountBasedExpenseLineDetail', description: l.description ?? `Line ${i + 1}`, quantity: 1, unitPrice: l.amount, amount: l.amount, taxRate: 0 }))),
  }
}

test('a negative AccountBasedExpenseLineDetail line is stored as a positive magnitude with is_reduction=true', async () => {
  const row = expenseRow('QB-3258', [{ amount: 5000 }, { amount: -4056.31, description: 'Reduction' }])
  const created = await expensesModule.createRecord!(row, { companyId: COMPANY, userId: 'user-1' } as never)
  const lines = db.expense_lines.filter((l) => l.expense_id === created.id)
  assert.equal(lines.length, 2)
  const positive = lines.find((l) => l.description === 'Line 1')!
  const reduction = lines.find((l) => l.description === 'Reduction')!
  assert.equal(positive.amount, 5000)
  assert.equal(positive.is_reduction, false)
  assert.equal(reduction.amount, 4056.31, 'the reduction line must be stored as a positive magnitude (satisfies amount >= 0)')
  assert.equal(reduction.is_reduction, true, 'the reduction line must be flagged so it posts as a credit, not a debit')
  assert.equal('unit_price' in reduction, false, 'expense_lines has no unit_price column; it must never be sent')
})

test('literal NETKOM case: QBO Expense 3637-style reversal pair also normalizes to positive magnitude + is_reduction', async () => {
  const row = expenseRow('QB-3637', [{ amount: 2449.57 }, { amount: 700 }, { amount: -2449.57, description: 'Reduction A' }, { amount: -700, description: 'Reduction B' }, { amount: 10 }])
  const created = await expensesModule.createRecord!(row, { companyId: COMPANY, userId: 'user-1' } as never)
  const lines = db.expense_lines.filter((l) => l.expense_id === created.id)
  const reductionA = lines.find((l) => l.description === 'Reduction A')!
  const reductionB = lines.find((l) => l.description === 'Reduction B')!
  assert.equal(reductionA.amount, 2449.57)
  assert.equal(reductionA.is_reduction, true)
  assert.equal(reductionB.amount, 700)
  assert.equal(reductionB.is_reduction, true)
})

test('an all-positive expense is unaffected: amount unchanged, is_reduction=false', async () => {
  const row = expenseRow('QB-NORMAL', [{ amount: 500 }])
  const created = await expensesModule.createRecord!(row, { companyId: COMPANY, userId: 'user-1' } as never)
  const line = db.expense_lines.find((l) => l.expense_id === created.id)!
  assert.equal(line.amount, 500)
  assert.equal(line.is_reduction, false)
})

test('persistence-boundary guard: no expense line with a negative amount is ever sent to insert', async () => {
  const row = expenseRow('QB-GUARD', [{ amount: -999, description: 'Reduction' }])
  await expensesModule.createRecord!(row, { companyId: COMPANY, userId: 'user-1' } as never)
  const line = db.expense_lines.find((l) => l.description === 'Reduction')!
  assert.ok(Number(line.amount) >= 0, 'no negative amount ever reached the repository insert')
})

test('postExpenseToLedger posts a reduction line as a credit and the resulting entry balances', async () => {
  const expenseId = randomUUID()
  db.expenses.push({ id: expenseId, company_id: COMPANY, status: 'APPROVED', expense_no: 'QB-3258', date: '2026-01-01', total: 945.69, tax_amount: 0, exchange_rate: 1 })
  db.expense_lines.push(
    { id: randomUUID(), expense_id: expenseId, company_id: COMPANY, account_id: 'acct-expense', amount: 5000, is_reduction: false, description: 'Normal' },
    { id: randomUUID(), expense_id: expenseId, company_id: COMPANY, account_id: 'acct-expense', amount: 4054.31, is_reduction: true, description: 'Reduction' },
  )

  await withCompanyContext(COMPANY, () => postExpenseToLedger(expenseId, COMPANY, 'SAR'))

  const entries = db.ledger_entries.filter((e) => e.source_id === expenseId && e.source_type === 'EXPENSE')
  assert.ok(entries.length >= 2, 'a real ledger entry must have been posted')
  const debitSum = entries.reduce((sum, e) => sum + Number(e.debit ?? 0), 0)
  const creditSum = entries.reduce((sum, e) => sum + Number(e.credit ?? 0), 0)
  assert.equal(debitSum, creditSum, 'debits must equal credits once the reduction line posts as a credit')
  const reductionEntry = entries.find((e) => Number(e.credit ?? 0) === 4054.31)
  assert.ok(reductionEntry, 'the reduction line must appear as a credit, not folded into the debit side')
})
