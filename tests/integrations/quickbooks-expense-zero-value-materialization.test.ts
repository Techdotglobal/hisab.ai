/**
 * Regression for two related NETKOM Expense-materialization defects found on
 * source 3966 — a genuine zero-value QuickBooks expense (total=0, taxAmount=0,
 * every line Amount=0):
 *
 * 1. `materializeQuickBooksAccounting` demanded a balanced (>=2 line) ledger
 *    posting even for a document with no economic content. `requiresLedgerFor()`
 *    already carved out a zero-total exemption for `journal-entries`; this fix
 *    extends the same exemption to `expenses` (accounting-materializer.ts:48).
 * 2. When a balanced posting genuinely is missing, the diagnostic error
 *    builder used to run `select('status,total,subtotal,tax_amount')` against
 *    `config.table` — `expenses` has no `subtotal` column, so Postgres raised
 *    `42703: column expenses.subtotal does not exist`, masking the real "did
 *    not produce a balanced ledger entry" error with an unrelated crash. The
 *    fix selects `*` instead (accounting-materializer.ts:131), which can never
 *    reference a nonexistent column.
 *
 * This file exercises the REAL `materializeQuickBooksAccounting` (and, for the
 * unbalanced case, the real `postExpenseToLedger`) against a minimal in-memory
 * fake of the `*.supabase.co` REST/RPC surface, following the same harness
 * pattern as quickbooks-expenses-negative-lines.test.ts.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-expense-zero-value-materialization.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://expense-zero-value-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { materializeQuickBooksAccounting } = requireModule('../../src/lib/import-export/quickbooks/accounting-materializer') as typeof import('../../src/lib/import-export/quickbooks/accounting-materializer')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')

const COMPANY = '44444444-4444-4444-4444-444444444444'
const REALM = 'realm-expense-zero-1'
// `postSourceDocumentToLedger` posts against the LOCAL record id (not the QBO
// source id) as `source_id`. This local id's RPC posting is deliberately made
// to insert zero ledger rows (see the rpc handler below) so the diagnostic
// (`ledgerEntryCount < 2`) branch fires deterministically, regardless of
// which real-world cause would normally produce a short posting.
const UNBALANCED_LOCAL_ID = 'local-unbalanced'

type Row = Record<string, unknown>

const db = {
  chart_of_accounts: [
    { id: 'acct-expense', company_id: COMPANY, account_no: '61-6101', name: 'Operating Expenses', canonical_type: 'Expense', is_active: true, deleted_at: null },
    { id: 'acct-bank', company_id: COMPANY, account_no: '11-1101-01', name: 'Cash and Bank', canonical_type: 'Asset', is_active: true, deleted_at: null },
  ],
  companies: [{ id: COMPANY, currency: 'SAR', reporting_currency: 'SAR' }],
  expenses: [] as Row[],
  expense_lines: [] as Row[],
  ledger_entries: [] as Row[],
  runs: [] as Row[],
  reset() { this.expenses = []; this.expense_lines = []; this.ledger_entries = []; this.runs = [] },
}

const RUN_MATCH_KEYS = ['company_id', 'realm_id', 'entity_type', 'source_id', 'module_key'] as const

function eqParam(url: URL, name: string): string | null {
  const v = url.searchParams.get(name)
  return v?.startsWith('eq.') ? v.slice(3) : null
}
function ilikePrefix(url: URL, name: string): string | null {
  const v = url.searchParams.get(name)
  if (!v?.startsWith('ilike.')) return null
  return v.slice(6).replace(/%$/, '')
}
function runMatchesUrl(row: Row, url: URL): boolean {
  for (const key of RUN_MATCH_KEYS) {
    const wanted = eqParam(url, key)
    if (wanted !== null && String(row[key] ?? '') !== wanted) return false
  }
  return true
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
    const pgError = (message: string, code: string) => new Response(JSON.stringify({ message, code }), { status: 400, headers: { 'content-type': 'application/json' } })

    if (table === 'companies' && method === 'GET') {
      return json(db.companies.find((c) => c.id === eqParam(url, 'id')) ?? null)
    }
    if (table === 'chart_of_accounts' && method === 'GET') {
      let matches = db.chart_of_accounts.filter((a) => a.company_id === eqParam(url, 'company_id'))
      const prefix = ilikePrefix(url, 'account_no')
      const canonicalType = eqParam(url, 'canonical_type')
      const nameIlike = ilikePrefix(url, 'name')
      if (prefix) matches = matches.filter((a) => String(a.account_no).startsWith(prefix))
      if (canonicalType) matches = matches.filter((a) => a.canonical_type === canonicalType)
      if (nameIlike) matches = matches.filter((a) => String(a.name).toLowerCase().includes(nameIlike.toLowerCase()))
      return json(matches)
    }
    if (table === 'expenses') {
      const select = url.searchParams.get('select') ?? ''
      if (method === 'GET') {
        // The pre-fix diagnostic query hardcoded this exact column list, which
        // crashes for `expenses` (no `subtotal`). Kept here purely to prove a
        // regression: the real code never sends this shape any more.
        if (select === 'status,total,subtotal,tax_amount') return pgError('column expenses.subtotal does not exist', '42703')
        const isEmbed = select.includes('expense_lines')
        const row = db.expenses.find((e) => e.id === eqParam(url, 'id'))
        if (!row) return json(null)
        if (isEmbed) return json({ ...row, lines: db.expense_lines.filter((l) => l.expense_id === row.id) })
        return json(row)
      }
    }
    if (table === 'ledger_entries' && method === 'GET') {
      let matches = db.ledger_entries.filter((e) => e.source_id === eqParam(url, 'source_id'))
      const sourceType = eqParam(url, 'source_type')
      if (sourceType) matches = matches.filter((e) => e.source_type === sourceType)
      return json(matches)
    }
    if (table === 'rpc/post_source_document_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_company_id: string; p_source_type: string; p_source_id: string; p_lines: Row[] }
      if (body.p_source_id !== UNBALANCED_LOCAL_ID) {
        for (const line of body.p_lines) {
          db.ledger_entries.push({ id: randomUUID(), company_id: body.p_company_id, source_type: body.p_source_type, source_id: body.p_source_id, posting_sequence: db.ledger_entries.length + 1, ...line })
        }
      }
      return json(db.ledger_entries.length, 200)
    }
    if (table.startsWith('rpc/') && method === 'POST') return json(null, 200)

    if (table === 'quickbooks_materialization_runs') {
      if (method === 'GET') {
        const match = db.runs.find((r) => runMatchesUrl(r, url))
        return json(match ?? null)
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Row
        const existing = db.runs.find((r) => RUN_MATCH_KEYS.every((k) => r[k] === body[k]))
        if (existing) Object.assign(existing, body)
        else db.runs.push({ ...body })
        return json(existing ?? body, 201)
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Row
        const matches = db.runs.filter((r) => runMatchesUrl(r, url))
        for (const row of matches) Object.assign(row, body)
        return json(matches)
      }
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => db.reset())

function sourceRow(sourceId: string, total: number) {
  return { _realmId: REALM, _quickbooksEntity: 'Purchase', _quickbooksId: sourceId, sourceId, total, currency: 'SAR' }
}

test('a genuine zero-value expense (total=0) completes without posting or requiring a ledger entry', async () => {
  const result = await materializeQuickBooksAccounting({
    companyId: COMPANY, userId: 'user-1', moduleKey: 'expenses', localId: 'local-3966',
    sourceRow: sourceRow('3966', 0),
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.ledgerEntryCount, 0)
  const run = db.runs.find((r) => r.module_key === 'expenses' && r.source_id === '3966')
  assert.equal(run?.status, 'completed', 'must not be marked failed for having no ledger entries')
  const validation = run?.validation as Row
  assert.equal(validation.zeroMovementDocument, true)
})

test('retrying the same zero-value expense a second time is idempotent (already completed, no double-processing)', async () => {
  const first = await materializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'expenses', localId: 'local-3966', sourceRow: sourceRow('3966', 0) })
  const second = await materializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'expenses', localId: 'local-3966', sourceRow: sourceRow('3966', 0) })
  assert.equal(first.status, 'completed')
  assert.equal(second.status, 'completed')
  assert.equal(second.ledgerEntryCount, 0)
})

test('the diagnostic query for a genuinely unbalanced expense never crashes on the missing subtotal column', async () => {
  db.expenses.push({ id: 'local-unbalanced', company_id: COMPANY, status: 'APPROVED', expense_no: 'QB-9001', date: '2026-01-01', total: 500, tax_amount: 0, exchange_rate: 1 })
  db.expense_lines.push({ id: randomUUID(), expense_id: 'local-unbalanced', company_id: COMPANY, account_id: 'acct-expense', amount: 500, is_reduction: false, description: 'Line 1' })

  await assert.rejects(
    () => withCompanyContext(COMPANY, () => materializeQuickBooksAccounting({
      companyId: COMPANY, userId: 'user-1', moduleKey: 'expenses', localId: 'local-unbalanced',
      sourceRow: sourceRow('9001', 500),
    })),
    (err: Error) => {
      assert.doesNotMatch(err.message, /does not exist/, 'must never surface a "column does not exist" crash')
      assert.doesNotMatch(err.message, /42703/)
      assert.match(err.message, /did not produce a balanced ledger entry/)
      assert.match(err.message, /ledgerEntries=0/)
      return true
    },
  )
  const run = db.runs.find((r) => r.module_key === 'expenses' && r.source_id === '9001')
  assert.equal(run?.status, 'failed')
  assert.doesNotMatch(String(run?.last_error), /does not exist/)
})
