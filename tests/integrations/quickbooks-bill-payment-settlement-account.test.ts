/**
 * Regression for the `qb-bill-payments` (materializeBillPayment) settlement-account gap found in the Phase 1 review:
 * unlike the primary `vendor-payments` path (transactions.module.ts createRecord), this materializer never resolved
 * CheckPayment.BankAccountRef/CreditCardPayment.CCAccountRef, so a payment created through it never had
 * payments.deposit_account_id set and posting fell through to the unordered accounts.bank default (an Equity account on
 * NETKOM's chart). It now mirrors the primary path exactly: same source fields, same shared deposit_account_id column
 * (no second settlement-account field for payments), same fail-closed rule for an unresolved QuickBooks account.
 *
 * Exercises the REAL `qb-bill-payments` extended-module `createRecord` (which wraps `materializeBillPayment`) against a
 * minimal in-memory fake of the `*.supabase.co` REST/RPC surface — harness pattern shared with
 * quickbooks-transfer-materialization.test.ts and quickbooks-settlement-account-posting.test.ts.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-bill-payment-settlement-account.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://bill-payment-settlement-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { quickBooksExtendedModules } = requireModule('../../src/lib/import-export/registry/modules/quickbooks-extended.module') as typeof import('../../src/lib/import-export/registry/modules/quickbooks-extended.module')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')

const COMPANY = '77777777-7777-7777-7777-777777777777'
const REALM = 'realm-bill-payment-1'
type Row = Record<string, unknown>

const db = {
  chart_of_accounts: [
    { id: 'coa-albilad', company_id: COMPANY, account_no: '32-3201-01', name: 'ALBILAD', canonical_type: 'Asset', is_active: true, deleted_at: null },
    // Deliberately Equity and sorts first under the '11-1101' prefix, mirroring NETKOM's General Reserve trap — proves the
    // resolved account is used instead of the accounts.bank default.
    { id: 'coa-equity', company_id: COMPANY, account_no: '11-1101-02', name: 'GENERAL RESERVE A/C', canonical_type: 'Equity', is_active: true, deleted_at: null },
    { id: 'coa-ap', company_id: COMPANY, account_no: '22-2201-01', name: 'ACCOUNTS PAYABLE', canonical_type: 'Liability', is_active: true, deleted_at: null },
  ],
  bills: [{ id: 'bill-1', company_id: COMPANY, bill_no: 'B-1', vendor_id: 'vendor-1', total: 8000, balance: 8000, amount_paid: 0, deleted_at: null }],
  quickbooks_migration_records: [
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '103', local_id: 'coa-albilad', local_table: 'chart_of_accounts' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Vendor', source_id: '500', local_id: 'vendor-1', local_table: 'vendors' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Bill', source_id: '2624', local_id: 'bill-1', local_table: 'bills' },
  ] as Row[],
  payments: [] as Row[],
  payment_allocations: [] as Row[],
  ledger_entries: [] as Row[],
  links: [] as Row[],
  warnings: [] as Row[],
  reset() { this.payments = []; this.payment_allocations = []; this.ledger_entries = []; this.links = []; this.warnings = [] },
}

const eq = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }
const inList = (url: URL, name: string) => { const v = url.searchParams.get(name); if (!v?.startsWith('in.(') || !v.endsWith(')')) return null; return v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')) }

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (table === 'quickbooks_migration_records') {
      if (method === 'GET') {
        const entityTypes = inList(url, 'entity_type'), sourceId = eq(url, 'source_id')
        const match = db.quickbooks_migration_records.find((r) => r.company_id === eq(url, 'company_id') && r.realm_id === eq(url, 'realm_id') && r.source_id === sourceId && (!entityTypes || entityTypes.includes(String(r.entity_type))))
        return json(match ? [match] : [])
      }
      if (method === 'POST') { const body = JSON.parse(String(init?.body ?? '{}')) as Row; db.quickbooks_migration_records.push(body); return json([{ id: randomUUID(), ...body }], 201) }
    }
    if (table === 'quickbooks_migration_local_links') { if (method === 'GET') return json([]); if (method === 'POST') { db.links.push(JSON.parse(String(init?.body ?? '{}'))); return json(null, 201) } }
    if (table === 'quickbooks_migration_warnings' && method === 'POST') { db.warnings.push(JSON.parse(String(init?.body ?? '{}'))); return json(null, 201) }

    if (table === 'chart_of_accounts' && method === 'GET') {
      let matches = db.chart_of_accounts.filter((a) => a.company_id === eq(url, 'company_id') && !a.deleted_at)
      const ids = inList(url, 'id')
      if (ids) return json(matches.filter((a) => ids.includes(a.id)))
      matches = matches.filter((a) => a.is_active)
      const prefix = url.searchParams.get('account_no')?.startsWith('ilike.') ? url.searchParams.get('account_no')!.slice(6).replace(/^%|%$/g, '') : null
      const canonicalType = eq(url, 'canonical_type')
      if (prefix) matches = matches.filter((a) => a.account_no.startsWith(prefix))
      if (canonicalType) matches = matches.filter((a) => a.canonical_type === canonicalType)
      const id = eq(url, 'id')
      if (id) matches = matches.filter((a) => a.id === id)
      matches = [...matches].sort((a, b) => a.account_no.localeCompare(b.account_no))
      return json(matches[0] ?? null)
    }
    if (table === 'bills') { if (method === 'GET') return json(db.bills.find((b) => b.id === eq(url, 'id')) ?? null) }
    if (table === 'payments') {
      if (method === 'GET') {
        const legacyId = eq(url, 'legacy_id'), id = eq(url, 'id')
        const match = db.payments.find((p) => p.company_id === eq(url, 'company_id') && (legacyId ? p.legacy_id === legacyId : id ? p.id === id : false))
        return json(match ?? null)
      }
      if (method === 'PATCH') { const id = eq(url, 'id'); const row = db.payments.find((p) => p.id === id); if (row) Object.assign(row, JSON.parse(String(init?.body ?? '{}'))); return json(row ? [row] : []) }
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.payments.push(row); return json(row, 201) }
    }
    if (table === 'payment_allocations' && method === 'GET') return json(db.payment_allocations)
    if (table === 'rpc/replace_payment_allocations' && method === 'POST') return json(null, 200)
    if (table === 'rpc/post_source_document_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_company_id: string; p_source_type: string; p_source_id: string; p_lines: Row[] }
      const seq = db.ledger_entries.length + 1
      for (const line of body.p_lines) db.ledger_entries.push({ id: randomUUID(), company_id: body.p_company_id, source_type: body.p_source_type, source_id: body.p_source_id, posting_sequence: seq, ...line })
      return json(seq, 200)
    }
    if (table === 'ledger_entries' && method === 'GET') return json(db.ledger_entries.filter((l) => l.source_id === eq(url, 'source_id')))
    if (table.startsWith('rpc/') && method === 'POST') return json(null, 200)

    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => db.reset())

function billPaymentModule() {
  const m = quickBooksExtendedModules.find((mod) => mod.key === 'qb-bill-payments')
  if (!m) throw new Error('qb-bill-payments module not found')
  return m
}
const row = (id: string, raw: Row) => ({ _realmId: REALM, sourceId: id, _quickbooksId: id, _quickbooksRaw: JSON.stringify(raw) })
const ctx = { companyId: COMPANY, userId: 'user-1' } as never

test('qb-bill-payments resolves CheckPayment.BankAccountRef and stores it as payments.deposit_account_id (not accounts.bank)', async () => {
  const raw = { Id: '2625', TotalAmt: 8000, VendorRef: { value: '500' }, PayType: 'Check', CheckPayment: { BankAccountRef: { value: '103' } }, Line: [{ Amount: 8000, LinkedTxn: [{ TxnType: 'Bill', TxnId: '2624' }] }] }
  await withCompanyContext(COMPANY, () => billPaymentModule().createRecord(row('2625', raw), ctx))
  assert.equal(db.payments.length, 1)
  assert.equal(db.payments[0].deposit_account_id, 'coa-albilad')
  assert.notEqual(db.payments[0].deposit_account_id, 'coa-equity')
})

test('qb-bill-payments posts its ledger credit to the resolved settlement account, not the unordered accounts.bank default', async () => {
  const raw = { Id: '2625', TotalAmt: 8000, VendorRef: { value: '500' }, PayType: 'Check', CheckPayment: { BankAccountRef: { value: '103' } }, Line: [{ Amount: 8000, LinkedTxn: [{ TxnType: 'Bill', TxnId: '2624' }] }] }
  await withCompanyContext(COMPANY, () => billPaymentModule().createRecord(row('2625', raw), ctx))
  const credit = db.ledger_entries.find((l) => Number(l.credit) > 0)
  assert.equal(credit?.account_id, 'coa-albilad')
  assert.notEqual(credit?.account_id, 'coa-equity')
})

test('qb-bill-payments resolves CreditCardPayment.CCAccountRef when there is no CheckPayment', async () => {
  db.quickbooks_migration_records.push({ company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '393', local_id: 'coa-ap', local_table: 'chart_of_accounts' })
  const raw = { Id: '9001', TotalAmt: 100, VendorRef: { value: '500' }, PayType: 'CreditCard', CreditCardPayment: { CCAccountRef: { value: '393' } }, Line: [{ Amount: 100, LinkedTxn: [{ TxnType: 'Bill', TxnId: '2624' }] }] }
  await withCompanyContext(COMPANY, () => billPaymentModule().createRecord(row('9001', raw), ctx))
  assert.equal(db.payments[0].deposit_account_id, 'coa-ap')
})

test('qb-bill-payments fails closed on an unresolved settlement account (throws before any payment/ledger write)', async () => {
  const raw = { Id: '2625', TotalAmt: 8000, VendorRef: { value: '500' }, PayType: 'Check', CheckPayment: { BankAccountRef: { value: '999' } }, Line: [{ Amount: 8000, LinkedTxn: [{ TxnType: 'Bill', TxnId: '2624' }] }] }
  await assert.rejects(
    () => withCompanyContext(COMPANY, () => billPaymentModule().createRecord(row('2625', raw), ctx)),
    /QuickBooks deposit account 999 must be migrated before payment 2625/,
  )
  assert.equal(db.payments.length, 0)
  assert.equal(db.ledger_entries.length, 0)
})

test('qb-bill-payments with no bank/credit-card account reference at all also fails closed at posting time (this materializer only ever handles QuickBooks-sourced payments, never a native fallback case)', async () => {
  const raw = { Id: '2625', TotalAmt: 8000, VendorRef: { value: '500' }, PayType: 'Check', Line: [{ Amount: 8000, LinkedTxn: [{ TxnType: 'Bill', TxnId: '2624' }] }] }
  await assert.rejects(
    () => withCompanyContext(COMPANY, () => billPaymentModule().createRecord(row('2625', raw), ctx)),
    /has no resolved settlement account/,
  )
})
