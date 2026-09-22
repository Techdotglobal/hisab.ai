/**
 * Regression for the posting-layer half of the settlement-account fix: `postExpenseToLedger` must credit
 * `expenses.settlement_account_id` when it is set, and must fail closed — never silently fall back to
 * `accounts.bank` (the unordered default that resolved to an Equity account on NETKOM) — for a QuickBooks-sourced
 * expense (`legacy_id` set) whose settlement account was never resolved.
 *
 * This file exercises the REAL `postExpenseToLedger` (via `materializeQuickBooksAccounting`) against a minimal
 * in-memory fake of the `*.supabase.co` REST/RPC surface, following the harness pattern of
 * quickbooks-expense-zero-value-materialization.test.ts.
 *
 * `postPaymentToLedger`'s equivalent fail-closed branch is verified at the source-code level below (the same pattern
 * `quickbooks-payment-relationships.test.ts` already uses for comparable posting-shape regressions); its behavioral
 * coverage — that `deposit_account_id` is what gets used, and that it is populated for both payment directions — is
 * exercised end to end in quickbooks-settlement-account-create-record.test.ts plus the existing 4693/payment suites.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-settlement-account-posting.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://settlement-account-posting-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { materializeQuickBooksAccounting } = requireModule('../../src/lib/import-export/quickbooks/accounting-materializer') as typeof import('../../src/lib/import-export/quickbooks/accounting-materializer')
const { postExpenseToLedger } = requireModule('../../src/lib/accounting/document-posting') as typeof import('../../src/lib/accounting/document-posting')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')

const COMPANY = '55555555-5555-5555-5555-555555555555'
const REALM = 'realm-settlement-posting-1'
type Row = Record<string, unknown>

const db = {
  chart_of_accounts: [
    { id: 'acct-expense', company_id: COMPANY, account_no: '61-6101', name: 'Operating Expenses', canonical_type: 'Expense', is_active: true, deleted_at: null },
    // Deliberately Equity, mirroring NETKOM's 11-1101 range, so a fall-through to accounts.bank would be visibly wrong.
    { id: 'acct-equity', company_id: COMPANY, account_no: '11-1101-110101-02', name: 'GENERAL RESERVE A/C', canonical_type: 'Equity', is_active: true, deleted_at: null },
    // The one properly-typed native default: what a native expense (no source account to resolve) should still fall
    // back to now that the lookup is canonicalType-filtered, proving the Equity account is excluded, not "no account at all".
    { id: 'acct-cash-and-bank', company_id: COMPANY, account_no: '11-1101-999999-01', name: 'Cash and Bank', canonical_type: 'Asset', is_active: true, deleted_at: null },
    { id: 'acct-albilad', company_id: COMPANY, account_no: '32-3201-320102-01', name: 'ALBILAD', canonical_type: 'Asset', is_active: true, deleted_at: null },
  ],
  companies: [{ id: COMPANY, currency: 'SAR', reporting_currency: 'SAR' }],
  expenses: [] as Row[],
  expense_lines: [] as Row[],
  ledger_entries: [] as Row[],
  runs: [] as Row[],
  reset() { this.expenses = []; this.expense_lines = []; this.ledger_entries = []; this.runs = [] },
}

const RUN_MATCH_KEYS = ['company_id', 'realm_id', 'entity_type', 'source_id', 'module_key'] as const
function eqParam(url: URL, name: string): string | null { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }
function ilikePrefix(url: URL, name: string): string | null { const v = url.searchParams.get(name); return v?.startsWith('ilike.') ? v.slice(6).replace(/^%|%$/g, '') : null }
function inValues(url: URL, name: string): string[] | null { const v = url.searchParams.get(name); if (!v?.startsWith('in.(') || !v.endsWith(')')) return null; return v.slice(4, -1).split(',') }
function runMatchesUrl(row: Row, url: URL): boolean { for (const key of RUN_MATCH_KEYS) { const wanted = eqParam(url, key); if (wanted !== null && String(row[key] ?? '') !== wanted) return false } return true }

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (table === 'companies' && method === 'GET') return json(db.companies.find((c) => c.id === eqParam(url, 'id')) ?? null)
    if (table === 'chart_of_accounts' && method === 'GET') {
      let matches = db.chart_of_accounts.filter((a) => a.company_id === eqParam(url, 'company_id') && !a.deleted_at)
      const ids = inValues(url, 'id')
      if (ids) { const result = matches.filter((a) => ids.includes(a.id)); return json(result) }
      matches = matches.filter((a) => a.is_active)
      const prefix = ilikePrefix(url, 'account_no'), canonicalType = eqParam(url, 'canonical_type')
      if (prefix) matches = matches.filter((a) => a.account_no.startsWith(prefix))
      if (canonicalType) matches = matches.filter((a) => a.canonical_type === canonicalType)
      matches = [...matches].sort((a, b) => a.account_no.localeCompare(b.account_no))
      return json(matches[0] ?? null)
    }
    if (table === 'expenses' && method === 'GET') {
      const isEmbed = (url.searchParams.get('select') ?? '').includes('expense_lines')
      const row = db.expenses.find((e) => e.id === eqParam(url, 'id'))
      if (!row) return json(null)
      return json(isEmbed ? { ...row, lines: db.expense_lines.filter((l) => l.expense_id === row.id) } : row)
    }
    if (table === 'ledger_entries' && method === 'GET') {
      let matches = db.ledger_entries.filter((e) => e.source_id === eqParam(url, 'source_id'))
      const sourceType = eqParam(url, 'source_type')
      if (sourceType) matches = matches.filter((e) => e.source_type === sourceType)
      return json(matches)
    }
    if (table === 'rpc/post_source_document_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_company_id: string; p_source_type: string; p_source_id: string; p_lines: Row[] }
      for (const line of body.p_lines) db.ledger_entries.push({ id: randomUUID(), company_id: body.p_company_id, source_type: body.p_source_type, source_id: body.p_source_id, posting_sequence: db.ledger_entries.length + 1, ...line })
      return json(db.ledger_entries.length, 200)
    }
    if (table.startsWith('rpc/') && method === 'POST') return json(null, 200)
    if (table === 'quickbooks_materialization_runs') {
      if (method === 'GET') return json(db.runs.find((r) => runMatchesUrl(r, url)) ?? null)
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Row
        const existing = db.runs.find((r) => RUN_MATCH_KEYS.every((k) => r[k] === body[k]))
        if (existing) Object.assign(existing, body); else db.runs.push({ ...body })
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

const sourceRow = (sourceId: string, total: number) => ({ _realmId: REALM, _quickbooksEntity: 'Purchase', _quickbooksId: sourceId, sourceId, total, currency: 'SAR' })

test('a QuickBooks expense with a resolved settlement_account_id posts its credit there, not to the unordered accounts.bank default', async () => {
  db.expenses.push({ id: 'local-1', company_id: COMPANY, legacy_id: '4513', status: 'APPROVED', expense_no: 'QB-4513', date: '2026-03-25', total: 500, tax_amount: 0, exchange_rate: 1, settlement_account_id: 'acct-albilad' })
  db.expense_lines.push({ id: randomUUID(), expense_id: 'local-1', company_id: COMPANY, account_id: 'acct-expense', amount: 500, is_reduction: false, description: 'Line 1' })

  const result = await withCompanyContext(COMPANY, () => materializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'expenses', localId: 'local-1', sourceRow: sourceRow('4513', 500) }))
  assert.equal(result.status, 'completed')
  const credit = db.ledger_entries.find((l) => Number(l.credit) > 0)
  assert.equal(credit?.account_id, 'acct-albilad', 'must credit the resolved settlement account')
  assert.notEqual(credit?.account_id, 'acct-equity', 'must never credit the unordered default (Equity here)')
})

test('a QuickBooks expense with no resolved settlement account fails closed instead of posting to accounts.bank', async () => {
  db.expenses.push({ id: 'local-2', company_id: COMPANY, legacy_id: '4514', status: 'APPROVED', expense_no: 'QB-4514', date: '2026-03-25', total: 500, tax_amount: 0, exchange_rate: 1, settlement_account_id: null })
  db.expense_lines.push({ id: randomUUID(), expense_id: 'local-2', company_id: COMPANY, account_id: 'acct-expense', amount: 500, is_reduction: false, description: 'Line 1' })

  await assert.rejects(
    () => withCompanyContext(COMPANY, () => materializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'expenses', localId: 'local-2', sourceRow: sourceRow('4514', 500) })),
    /has no resolved settlement account/,
  )
  assert.equal(db.ledger_entries.length, 0, 'nothing may post while the settlement account is unresolved')
})

test('a native expense (no legacy_id) with no settlement_account_id still falls back to accounts.bank — that fallback is preserved for non-QuickBooks records', async () => {
  db.expenses.push({ id: 'local-3', company_id: COMPANY, legacy_id: null, status: 'APPROVED', expense_no: 'EXP-1', date: '2026-03-25', total: 100, tax_amount: 0, exchange_rate: 1, settlement_account_id: null })
  db.expense_lines.push({ id: randomUUID(), expense_id: 'local-3', company_id: COMPANY, account_id: 'acct-expense', amount: 100, is_reduction: false, description: 'Line 1' })

  // Called directly (as the native approval route does), not through the QuickBooks materializer wrapper.
  await withCompanyContext(COMPANY, () => postExpenseToLedger('local-3', COMPANY, 'SAR'))
  const credit = db.ledger_entries.find((l) => Number(l.credit) > 0)
  assert.equal(credit?.account_id, 'acct-cash-and-bank', 'the canonicalType-filtered accounts.bank default correctly excludes the Equity account and resolves the real Bank/Asset one — unchanged intent, now type-safe')
})

test('postPaymentToLedger fails closed for a QuickBooks-sourced payment with no resolved settlement account (source-level guard)', () => {
  const src = readFileSync('src/lib/accounting/document-posting.ts', 'utf8')
  assert.match(src, /if\(payment\.legacy_id\)throw new Error\(`QuickBooks payment \$\{payment\.payment_no\} has no resolved settlement account/)
  assert.match(src, /if\(payment\.deposit_account_id\)settlementAccount=String\(payment\.deposit_account_id\)/, 'deposit_account_id must be used for both payment directions, not only customer payments')
})
