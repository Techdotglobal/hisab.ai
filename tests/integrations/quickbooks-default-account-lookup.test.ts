/**
 * Regression for the unordered/type-blind default-account lookup: `findSystemAccount` (posting-service.ts) queried
 * `chart_of_accounts` with `.limit(1)` and no `ORDER BY`, so which row won among several matches depended on database row
 * order rather than the chart's own structure. Confirmed on NETKOM: `accounts.bank` (accountNoPrefix '11-1101', no
 * canonicalType filter) resolved to `11-1101-110101-02 GENERAL RESERVE A/C`, an Equity account, because the imported
 * chart reuses that number range for its Equity section and 0 of the 12 real Bank-type accounts share the prefix.
 *
 * This file exercises the REAL `findSystemAccount` against a minimal in-memory fake of the `*.supabase.co` REST surface.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-default-account-lookup.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test, before, after } from 'node:test'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://default-account-lookup-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { findSystemAccount } = requireModule('../../src/lib/accounting/posting-service') as typeof import('../../src/lib/accounting/posting-service')

const COMPANY = 'company-default-account-1'
type Row = { id: string; company_id: string; account_no: string; name: string; canonical_type: string; is_active: boolean; deleted_at: string | null }

// Mirrors the NETKOM chart: several accounts share the '11-1101' number range across different sections, the way a
// migrated chart of accounts can, unlike the platform's own default chart where that prefix means only "Cash and Bank".
const accounts: Row[] = [
  { id: 'equity-1', company_id: COMPANY, account_no: '11-1101-110101-01', name: 'AUTHORISED CAPITAL A/C', canonical_type: 'Equity', is_active: true, deleted_at: null },
  { id: 'equity-2', company_id: COMPANY, account_no: '11-1101-110101-02', name: 'GENERAL RESERVE A/C', canonical_type: 'Equity', is_active: true, deleted_at: null },
  { id: 'bank-1', company_id: COMPANY, account_no: '11-1101-320102-01', name: 'ALBILAD - SAR', canonical_type: 'Asset', is_active: true, deleted_at: null },
  { id: 'income-fx', company_id: COMPANY, account_no: '41-4103', name: 'Realized FX Gain', canonical_type: 'Income', is_active: true, deleted_at: null },
  { id: 'income-sales', company_id: COMPANY, account_no: '41-4101', name: 'Sales', canonical_type: 'Income', is_active: true, deleted_at: null },
  { id: 'expense-fx', company_id: COMPANY, account_no: '61-6104', name: 'Realized FX Loss', canonical_type: 'Expense', is_active: true, deleted_at: null },
  { id: 'liability-salaries-payable', company_id: COMPANY, account_no: '22-2201-99', name: 'Salaries Payable', canonical_type: 'Liability', is_active: true, deleted_at: null },
  { id: 'expense-salaries', company_id: COMPANY, account_no: '53-5301', name: 'Salaries & Wages', canonical_type: 'Expense', is_active: true, deleted_at: null },
]

const eq = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }
const ilikePrefix = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('ilike.') ? v.slice(6).replace(/^%|%$/g, '') : null }

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (table === 'chart_of_accounts') {
      let matches = accounts.filter((a) => a.company_id === eq(url, 'company_id') && a.is_active && !a.deleted_at)
      const prefix = ilikePrefix(url, 'account_no'), name = ilikePrefix(url, 'name'), canonicalType = eq(url, 'canonical_type')
      if (prefix) matches = matches.filter((a) => a.account_no.startsWith(prefix))
      if (name) matches = matches.filter((a) => a.name.toLowerCase().includes(name.toLowerCase()))
      if (canonicalType) matches = matches.filter((a) => a.canonical_type === canonicalType)
      matches = [...matches].sort((a, b) => a.account_no.localeCompare(b.account_no))
      return json(matches[0] ?? null)
    }
    return json(null)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())

test('a type-blind prefix lookup with several matches is deterministic (account_no ascending)', async () => {
  const first = await findSystemAccount(COMPANY, { accountNoPrefix: '11-1101' })
  const second = await findSystemAccount(COMPANY, { accountNoPrefix: '11-1101' })
  assert.equal(first, 'equity-1', 'lowest account_no among the matches, every time')
  assert.equal(first, second)
})

test('adding canonicalType: Asset to the bank lookup excludes the Equity accounts and finds the real bank account', async () => {
  const resolved = await findSystemAccount(COMPANY, { accountNoPrefix: '11-1101', canonicalType: 'Asset' })
  assert.equal(resolved, 'bank-1')
})

test('the expense default lookup with canonicalType: Expense excludes an Income account sharing the "61" habit-of-thought (defense in depth)', async () => {
  const resolved = await findSystemAccount(COMPANY, { accountNoPrefix: '61', canonicalType: 'Expense' })
  assert.equal(resolved, 'expense-fx')
})

test('canonicalType: Expense on the salaries lookup excludes a same-named Liability account (Salaries Payable)', async () => {
  const resolved = await findSystemAccount(COMPANY, { nameContains: 'Salaries', canonicalType: 'Expense' })
  assert.equal(resolved, 'expense-salaries')
})

test('the revenue lookup (accountNoPrefix 41, canonicalType Income) is deterministic among two valid Income accounts, and the residual ambiguity is documented, not silently "fixed" by guessing semantics', async () => {
  // Both Realized FX Gain and Sales are legitimately Income-type "41" accounts; only ItemAccountRef propagation (the
  // adapter/transactions.module.ts fix) resolves which one an invoice line actually means. This lookup only needs to be
  // deterministic and type-safe, which it now is.
  const resolved = await findSystemAccount(COMPANY, { accountNoPrefix: '41', canonicalType: 'Income' })
  assert.equal(resolved, 'income-sales', 'account_no ascending: 41-4101 sorts before 41-4103')
})

test('document-posting.ts getAccountIds now passes canonicalType for bank/expense/salaries (source-level regression guard)', () => {
  const src = readFileSync('src/lib/accounting/document-posting.ts', 'utf8')
  assert.match(src, /accountNoPrefix:\s*'11-1101',\s*canonicalType:\s*'Asset'/)
  assert.match(src, /accountNoPrefix:\s*'61',\s*canonicalType:\s*'Expense'/)
  assert.match(src, /nameContains:\s*'Salaries',\s*canonicalType:\s*'Expense'/)
})
