/**
 * Phase 2 item 4: the "29 JE-linked vendor payments" and payment 2625. A vendor Payment's LinkedTxn can name a
 * JournalEntry either as the settlement TARGET (the payment pays down a JE-originated AP liability directly — no
 * Bill involved) or as a CREDIT SOURCE alongside a Bill target (payment 2625: JE 2495 credits Bills 2624/4767). Both
 * now resolve through the vendor_open_items subledger index created by createJournalVendorOpenItems
 * (transactions.module.ts) — see src/lib/accounting/vendor-open-items.ts and
 * supabase/migrations/075_vendor_open_items.sql (authored, not applied). The JE/Bill itself is never re-posted.
 *
 * Exercises extractQuickBooksPaymentRelationships, resolveQuickBooksPaymentAllocations, and the real `vendor-payments`
 * module `createRecord` against a minimal in-memory fake of the `*.supabase.co` REST/RPC surface.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-je-linked-vendor-payments.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://je-linked-vendor-payments-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { extractQuickBooksPaymentRelationships } = requireModule('../../src/lib/import-export/quickbooks/payment-relationships') as typeof import('../../src/lib/import-export/quickbooks/payment-relationships')
const { resolveQuickBooksPaymentAllocations } = requireModule('../../src/lib/accounting/payment-allocations') as typeof import('../../src/lib/accounting/payment-allocations')
const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const { QuickBooksImportAdapter } = requireModule('../../src/lib/import-export/sources/quickbooks.adapter') as typeof import('../../src/lib/import-export/sources/quickbooks.adapter')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')
const vendorPaymentModule = transactionModuleMap.get('vendor-payments')!

const COMPANY = '66666666-6666-6666-6666-666666666666'
const REALM = 'realm-je-linked-vendor-payments-1'
const VENDOR_LOCAL_ID = 'd5555555-5555-5555-5555-555555555551'
type Row = Record<string, unknown>

// ---------------------------------------------------------------- pure extraction (no I/O)
test('a payment line whose only link is a JournalEntry settles that JE-originated liability directly (a "29 JE-linked vendor payments" case)', () => {
  const result = extractQuickBooksPaymentRelationships({ TotalAmt: 5000, UnappliedAmt: 0, Line: [{ Amount: 5000, LinkedTxn: [{ TxnType: 'Journal Entry', TxnId: '2671' }] }] }, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.equal(result.allocations.length, 1)
  assert.equal(result.allocations[0].targetType, 'JournalEntry')
  assert.equal(result.allocations[0].targetSourceId, '2671')
  assert.equal(result.allocations[0].amount, 5000)
  assert.equal(result.allocations[0].cashAmount, 5000)
})

test('an explicit same-line JournalEntry credit (co-listed with its Bill target) settles that exact Bill', () => {
  const raw = {
    Id: 'SYNTHETIC-1', TotalAmt: 650, UnappliedAmt: 0,
    Line: [
      { Amount: 500, LinkedTxn: [{ TxnType: 'Bill', TxnId: '2624' }] },
      { Amount: 300, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4767' }, { TxnType: 'Journal Entry', TxnId: '2495' }] },
    ],
  }
  const result = extractQuickBooksPaymentRelationships(raw, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.equal(result.allocations.length, 2)
  const [bill2624, bill4767] = result.allocations
  assert.equal(bill2624.targetType, 'Bill'); assert.equal(bill2624.targetSourceId, '2624')
  assert.equal(bill2624.amount, 500); assert.equal(bill2624.cashAmount, 500); assert.equal(bill2624.creditAmount, 0)
  assert.equal(bill4767.targetType, 'Bill'); assert.equal(bill4767.targetSourceId, '4767')
  assert.equal(bill4767.amount, 300); assert.equal(bill4767.cashAmount, 150); assert.equal(bill4767.creditAmount, 150)
  assert.deepEqual(bill4767.creditSourceIds, ['2495'])
  assert.equal(bill4767.creditSourceTypes['2495'], 'JournalEntry')
  assert.equal(bill2624.cashAmount + bill4767.cashAmount, 650, 'cash total must equal TotalAmt - UnappliedAmt')
})

// Real NETKOM production payload (BillPayment 2625, confirmed via quickbooks_migration_records): JE 2495 is its OWN
// line — not co-listed with Bill 4767's line — so it is a STAND-ALONE credit. The order-based pairing (identical
// design to "existing payments the order-based pairing already certifies keep byte-identical allocations") assigns
// it to Bill 2624, the FIRST target with room — not to Bill 4767, even though the JE's amount happens to exactly
// match Bill 4767's own line amount. Re-pairing by amount instead would silently rewrite an already-materialized
// allocation on every re-sync, which is exactly the failure mode that existing rule already guards against.
test('payment 2625 (real payload shape): JE 2495 is a stand-alone line and credits Bill 2624 (first target), not Bill 4767', () => {
  const raw = {
    Id: '2625', TotalAmt: 8000, UnappliedAmt: 0,
    Line: [
      { Amount: 8000, LinkedTxn: [{ TxnType: 'Bill', TxnId: '2624' }] },
      { Amount: 1467.4, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4767' }] },
      { Amount: 1467.4, LinkedTxn: [{ TxnType: 'Journal Entry', TxnId: '2495' }] },
    ],
  }
  const result = extractQuickBooksPaymentRelationships(raw, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.equal(result.allocations.length, 2)
  const [bill2624, bill4767] = result.allocations
  assert.equal(bill2624.targetSourceId, '2624'); assert.equal(bill2624.amount, 8000)
  assert.equal(bill2624.cashAmount, 6532.6); assert.equal(bill2624.creditAmount, 1467.4)
  assert.deepEqual(bill2624.creditSourceIds, ['2495']); assert.equal(bill2624.creditSourceTypes['2495'], 'JournalEntry')
  assert.equal(bill4767.targetSourceId, '4767'); assert.equal(bill4767.amount, 1467.4)
  assert.equal(bill4767.cashAmount, 1467.4); assert.equal(bill4767.creditAmount, 0)
  assert.equal(bill2624.cashAmount + bill4767.cashAmount, 8000)
})

test('a JournalEntry accompanying a Bill on the same line is a credit, not a competing target (targets.length stays 1)', () => {
  const result = extractQuickBooksPaymentRelationships({ TotalAmt: 100, UnappliedAmt: 0, Line: [{ Amount: 100, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B-1' }, { TxnType: 'Journal Entry', TxnId: 'JE-1' }] }] }, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.equal(result.allocations.length, 1)
  assert.equal(result.allocations[0].targetType, 'Bill')
})

// ---------------------------------------------------------------- resolveQuickBooksPaymentAllocations (I/O)
const db = {
  vendor_open_items: [
    { id: 'voi-2495', company_id: COMPANY, vendor_id: VENDOR_LOCAL_ID, direction: 'CREDIT', source_type: 'JOURNAL_ENTRY', source_id: randomUUID(), source_system: 'QUICKBOOKS', source_reference: '2495:0', total: 150, applied_amount: 0, balance: 150, deleted_at: null },
    { id: 'voi-2671', company_id: COMPANY, vendor_id: VENDOR_LOCAL_ID, direction: 'PAYABLE', source_type: 'JOURNAL_ENTRY', source_id: randomUUID(), source_system: 'QUICKBOOKS', source_reference: '2671:0', total: 5000, applied_amount: 0, balance: 5000, deleted_at: null },
  ] as Row[],
  quickbooks_migration_records: [
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Bill', source_id: '2624', local_id: 'bill-2624', local_table: 'bills' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Bill', source_id: '4767', local_id: 'bill-4767', local_table: 'bills' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Vendor', source_id: '500', local_id: VENDOR_LOCAL_ID, local_table: 'vendors' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '103', local_id: 'coa-bank', local_table: 'chart_of_accounts' },
  ] as Row[],
}
const eq = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }
const inList = (url: URL, name: string) => { const v = url.searchParams.get(name); if (!v?.startsWith('in.(') || !v.endsWith(')')) return null; return v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')) }
const like = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('like.') ? v.slice(5) : null }

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (table === 'quickbooks_migration_records' && method === 'GET') {
      const entityTypes = inList(url, 'entity_type'), sourceId = eq(url, 'source_id')
      const match = db.quickbooks_migration_records.find((r) => r.company_id === eq(url, 'company_id') && r.realm_id === eq(url, 'realm_id') && r.source_id === sourceId && (!entityTypes || entityTypes.includes(String(r.entity_type))))
      return json(match ? [match] : [])
    }
    if (table === 'vendor_open_items' && method === 'GET') {
      const pattern = like(url, 'source_reference')
      const prefix = pattern?.endsWith('%') ? pattern.slice(0, -1) : pattern
      const matches = db.vendor_open_items.filter((r) =>
        r.company_id === eq(url, 'company_id') &&
        (eq(url, 'vendor_id') === null || r.vendor_id === eq(url, 'vendor_id')) &&
        (eq(url, 'source_type') === null || r.source_type === eq(url, 'source_type')) &&
        (prefix === null || String(r.source_reference).startsWith(prefix)) &&
        !r.deleted_at,
      )
      return json(matches)
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())

test('resolveQuickBooksPaymentAllocations resolves a JournalEntry TARGET via vendor_open_items, not bills', async () => {
  const relationships = extractQuickBooksPaymentRelationships({ TotalAmt: 5000, UnappliedAmt: 0, Line: [{ Amount: 5000, LinkedTxn: [{ TxnType: 'Journal Entry', TxnId: '2671' }] }] }, 'VENDOR')
  const resolved = await resolveQuickBooksPaymentAllocations({ companyId: COMPANY, realmId: REALM, sourcePaymentId: '9999', kind: 'VENDOR', currency: 'SAR', exchangeRate: 1, allocations: relationships.allocations, vendorId: VENDOR_LOCAL_ID })
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].vendorOpenItemId, 'voi-2671')
  assert.equal(resolved[0].billId, null)
  assert.equal(resolved[0].invoiceId, null)
})

test('resolveQuickBooksPaymentAllocations resolves an explicit same-line JournalEntry credit as a local credit id (not a vendor_credits id)', async () => {
  const raw = { Id: 'SYNTHETIC-2', TotalAmt: 650, UnappliedAmt: 0, Line: [
    { Amount: 500, LinkedTxn: [{ TxnType: 'Bill', TxnId: '2624' }] },
    { Amount: 300, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4767' }, { TxnType: 'Journal Entry', TxnId: '2495' }] },
  ] }
  const relationships = extractQuickBooksPaymentRelationships(raw, 'VENDOR')
  const resolved = await resolveQuickBooksPaymentAllocations({ companyId: COMPANY, realmId: REALM, sourcePaymentId: '2625', kind: 'VENDOR', currency: 'SAR', exchangeRate: 1, allocations: relationships.allocations, vendorId: VENDOR_LOCAL_ID })
  assert.equal(resolved.length, 2)
  const [alloc2624, alloc4767] = resolved
  assert.equal(alloc2624.billId, 'bill-2624'); assert.equal(alloc2624.vendorOpenItemId, null); assert.equal(alloc2624.creditAmount, 0)
  assert.equal(alloc4767.billId, 'bill-4767'); assert.equal(alloc4767.creditAmount, 150)
  assert.deepEqual(alloc4767.localCreditIds, ['voi-2495'], 'the JE-originated open item id, not a vendor_credits id')
})

test('an unmigrated JournalEntry target fails closed rather than silently dropping the allocation', async () => {
  const relationships = extractQuickBooksPaymentRelationships({ TotalAmt: 100, UnappliedAmt: 0, Line: [{ Amount: 100, LinkedTxn: [{ TxnType: 'Journal Entry', TxnId: '999999' }] }] }, 'VENDOR')
  await assert.rejects(
    () => resolveQuickBooksPaymentAllocations({ companyId: COMPANY, realmId: REALM, sourcePaymentId: '1', kind: 'VENDOR', currency: 'SAR', exchangeRate: 1, allocations: relationships.allocations, vendorId: VENDOR_LOCAL_ID }),
    /No vendor open item was materialized for QuickBooks JOURNAL_ENTRY 999999/,
  )
})

test('a JournalEntry-target allocation with no resolved vendor identity fails closed', async () => {
  const relationships = extractQuickBooksPaymentRelationships({ TotalAmt: 5000, UnappliedAmt: 0, Line: [{ Amount: 5000, LinkedTxn: [{ TxnType: 'Journal Entry', TxnId: '2671' }] }] }, 'VENDOR')
  await assert.rejects(
    () => resolveQuickBooksPaymentAllocations({ companyId: COMPANY, realmId: REALM, sourcePaymentId: '9999', kind: 'VENDOR', currency: 'SAR', exchangeRate: 1, allocations: relationships.allocations }),
    /has no resolved vendor identity/,
  )
})

// ---------------------------------------------------------------- end-to-end createRecord (RPC payload capture)
const dbRpc = { calls: [] as Row[], reset() { this.calls = [] } }
let restoreRpcFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (table === 'quickbooks_migration_records' && method === 'GET') {
      const entityTypes = inList(url, 'entity_type'), sourceId = eq(url, 'source_id')
      const match = db.quickbooks_migration_records.find((r) => r.company_id === eq(url, 'company_id') && r.realm_id === eq(url, 'realm_id') && r.source_id === sourceId && (!entityTypes || entityTypes.includes(String(r.entity_type))))
      return json(match ? [match] : [])
    }
    if (table === 'vendor_open_items' && method === 'GET') {
      const pattern = like(url, 'source_reference'); const prefix = pattern?.endsWith('%') ? pattern.slice(0, -1) : pattern
      const matches = db.vendor_open_items.filter((r) => r.company_id === eq(url, 'company_id') && (eq(url, 'vendor_id') === null || r.vendor_id === eq(url, 'vendor_id')) && (eq(url, 'source_type') === null || r.source_type === eq(url, 'source_type')) && (prefix === null || String(r.source_reference).startsWith(prefix)) && !r.deleted_at)
      return json(matches)
    }
    if (table === 'payments') {
      if (method === 'GET') return json([])
      if (method === 'POST') return json({ id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }, 201)
    }
    if (table === 'rpc/replace_payment_allocations' && method === 'POST') { dbRpc.calls.push(JSON.parse(String(init?.body ?? '{}'))); return json(null, 200) }
    if (table.startsWith('rpc/') && method === 'POST') return json(null, 200)
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreRpcFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreRpcFetch?.())
beforeEach(() => dbRpc.reset())

const ctx = { companyId: COMPANY, userId: 'user-1' } as never

test('the vendor-payments module materializes the real payment 2625 shape end to end: JE 2495 (its own line) credits Bill 2624', async () => {
  const raw = {
    Id: '2625', DocNumber: 'BP-2625', TxnDate: '2024-06-01', TotalAmt: 8000,
    VendorRef: { value: '500', name: 'Acme Supplies' },
    CheckPayment: { BankAccountRef: { value: '103' } },
    Line: [
      { Amount: 8000, LinkedTxn: [{ TxnType: 'Bill', TxnId: '2624' }] },
      { Amount: 1467.4, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4767' }] },
      { Amount: 1467.4, LinkedTxn: [{ TxnType: 'Journal Entry', TxnId: '2495' }] },
    ],
  }
  const mapped = new QuickBooksImportAdapter().normalizeRecords('vendor-payments', [raw], REALM)[0] as Record<string, unknown>
  await withCompanyContext(COMPANY, () => vendorPaymentModule.createRecord!(mapped, ctx))
  assert.equal(dbRpc.calls.length, 1)
  const allocations = dbRpc.calls[0].p_allocations as Row[]
  assert.equal(allocations.length, 2)
  const bill2624 = allocations.find((a) => a.bill_id === 'bill-2624')!
  assert.equal(Number(bill2624.cash_amount), 6532.6)
  assert.equal(Number(bill2624.credit_amount), 1467.4)
  assert.deepEqual(bill2624.local_credit_ids, ['voi-2495'])
  const bill4767 = allocations.find((a) => a.bill_id === 'bill-4767')!
  assert.equal(Number(bill4767.cash_amount), 1467.4)
  assert.equal(Number(bill4767.credit_amount), 0)
})

test('the vendor-payments module materializes a pure JE-target payment (the "29 JE-linked vendor payments" case)', async () => {
  const raw = {
    Id: '2671', DocNumber: 'BP-2671', TxnDate: '2024-06-01', TotalAmt: 5000,
    VendorRef: { value: '500', name: 'Acme Supplies' },
    CheckPayment: { BankAccountRef: { value: '103' } },
    Line: [{ Amount: 5000, LinkedTxn: [{ TxnType: 'Journal Entry', TxnId: '2671' }] }],
  }
  const mapped = new QuickBooksImportAdapter().normalizeRecords('vendor-payments', [raw], REALM)[0] as Record<string, unknown>
  await withCompanyContext(COMPANY, () => vendorPaymentModule.createRecord!(mapped, ctx))
  assert.equal(dbRpc.calls.length, 1)
  const allocations = dbRpc.calls[0].p_allocations as Row[]
  assert.equal(allocations.length, 1)
  assert.equal(allocations[0].vendor_open_item_id, 'voi-2671')
  assert.equal(allocations[0].bill_id, null)
  assert.equal(Number(allocations[0].amount), 5000)
})
