/**
 * Regression: `transactions.module.ts` `createRecord` must resolve a QuickBooks-sourced payment's/expense's settlement
 * account and store it on the header (`payments.deposit_account_id` for both payment directions,
 * `expenses.settlement_account_id`), and must fail closed — never silently create the record with the account
 * unresolved — when the source names an account that has not been migrated.
 *
 * Exercises the REAL `bills`/`vendor-payments`/`customer-payments`/`expenses` `createRecord` against a minimal in-memory
 * fake of the `*.supabase.co` REST surface (same harness shape as quickbooks-bill-balance-initialization.test.ts).
 *
 * Run: npx tsx --test tests/integrations/quickbooks-settlement-account-create-record.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://settlement-account-create-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const vendorPaymentModule = transactionModuleMap.get('vendor-payments')!
const customerPaymentModule = transactionModuleMap.get('customer-payments')!
const expenseModule = transactionModuleMap.get('expenses')!
const invoiceModule = transactionModuleMap.get('invoices')!

const COMPANY = 'company-settlement-1'
const REALM = 'realm-settlement-1'

type Row = Record<string, unknown>
const db = {
  vendors: [{ id: 'vendor-1', company_id: COMPANY, name: 'Test Vendor', deleted_at: null }],
  customers: [{ id: 'customer-1', company_id: COMPANY, name: 'Test Customer', deleted_at: null }],
  chart_of_accounts: [{ id: 'acct-albilad', company_id: COMPANY, account_no: '32-3201-320102-01', name: 'ALBILAD', deleted_at: null }],
  // resolveQuickBooksLocalId checks quickbooks_migration_records first (before quickbooks_migration_local_links).
  quickbooks_migration_records: [
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '103', local_id: 'acct-albilad', local_table: 'chart_of_accounts' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Vendor', source_id: '500', local_id: 'vendor-1', local_table: 'vendors' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Customer', source_id: '1', local_id: 'customer-1', local_table: 'customers' },
  ],
  payments: [] as Row[],
  expenses: [] as Row[],
  expense_lines: [] as Row[],
  reset() { this.payments = []; this.expenses = []; this.expense_lines = [] },
}
const eq = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }
/** `.in('col', [...])` -> `col=in.(a,b)`; returns null (no filter) when the param is absent. */
const inValues = (url: URL, name: string): string[] | null => { const v = url.searchParams.get(name); if (!v?.startsWith('in.(') || !v.endsWith(')')) return null; return v.slice(4, -1).split(',') }

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (table === 'vendors' && method === 'GET') return json(db.vendors.filter((v) => v.name === eq(url, 'name')))
    if (table === 'customers' && method === 'GET') return json(db.customers.filter((c) => c.name === eq(url, 'name')))
    if (table === 'quickbooks_migration_records' && method === 'GET') {
      const entityTypes = inValues(url, 'entity_type'), localTables = inValues(url, 'local_table')
      const match = db.quickbooks_migration_records.find((l) =>
        l.company_id === eq(url, 'company_id') && l.realm_id === eq(url, 'realm_id') && l.source_id === eq(url, 'source_id')
        && (!entityTypes || entityTypes.includes(l.entity_type)) && (!localTables || localTables.includes(l.local_table)))
      return json(match ? [match] : [])
    }
    if (table === 'chart_of_accounts' && method === 'GET') return json(db.chart_of_accounts.filter((a) => a.id === eq(url, 'id')))
    if (table === 'payments') {
      if (method === 'GET') return json([])
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.payments.push(row); return json(row, 201) }
    }
    if (table === 'expenses') {
      if (method === 'GET') return json([])
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.expenses.push(row); return json(row, 201) }
    }
    if (table === 'expense_lines' && method === 'POST') { db.expense_lines.push({ id: randomUUID() }); return json([{ id: randomUUID() }], 201) }
    if (table === 'payment_allocations' && method === 'DELETE') return json([])
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => db.reset())

const ctx = { companyId: COMPANY, userId: 'user-1' } as never
const vpRow = (overrides: Row = {}) => ({ transactionNo: 'QB-2625', vendorName: 'Test Vendor', status: 'COMPLETE', currency: 'SAR', date: '2026-05-31', amount: '8000', subtotal: '8000', taxAmount: '0', total: '8000', sourceId: '2625', vendorSourceId: '500', paymentMethod: 'Cash', relationshipIssues: '[]', allocations: '[]', unappliedAmount: '0', lines: '[]', _realmId: REALM, ...overrides })
const cpRow = (overrides: Row = {}) => ({ transactionNo: 'QB-1', customerName: 'Test Customer', status: 'COMPLETE', currency: 'SAR', date: '2026-05-31', amount: '100', subtotal: '100', taxAmount: '0', total: '100', sourceId: '1', customerSourceId: '1', paymentMethod: 'Cash', relationshipIssues: '[]', allocations: '[]', unappliedAmount: '0', lines: '[]', _realmId: REALM, ...overrides })
const expRow = (overrides: Row = {}) => ({ transactionNo: 'QB-4513', status: 'APPROVED', currency: 'SAR', date: '2026-03-25', subtotal: '500', taxAmount: '0', total: '500', sourceId: '4513', lines: '[]', _realmId: REALM, ...overrides })

// ---------------------------------------------------------------- vendor payment
test('a vendor payment whose source bank account resolves stores it on deposit_account_id', async () => {
  await vendorPaymentModule.createRecord!(vpRow({ depositAccountSourceId: '103' }), ctx)
  assert.equal(db.payments[0].deposit_account_id, 'acct-albilad')
})

test('a vendor payment whose source bank account cannot be resolved fails closed (throws, no record created)', async () => {
  await assert.rejects(
    () => vendorPaymentModule.createRecord!(vpRow({ depositAccountSourceId: '99' }), ctx),
    /QuickBooks deposit account 99 must be migrated/,
  )
  assert.equal(db.payments.length, 0, 'no payment must be created when the settlement account cannot be resolved')
})

test('a vendor payment with no source account reference at all is created without deposit_account_id (native fallback still applies at posting time)', async () => {
  await vendorPaymentModule.createRecord!(vpRow({ depositAccountSourceId: undefined }), ctx)
  assert.equal(db.payments[0].deposit_account_id, undefined)
})

// ---------------------------------------------------------------- customer payment (must be unaffected)
test('a customer payment keeps its existing deposit-account behavior unchanged', async () => {
  await customerPaymentModule.createRecord!(cpRow({ depositAccountSourceId: '103' }), ctx)
  assert.equal(db.payments[0].deposit_account_id, 'acct-albilad')
})

test('a customer payment still fails closed on an unresolved deposit account (existing behavior preserved)', async () => {
  await assert.rejects(() => customerPaymentModule.createRecord!(cpRow({ depositAccountSourceId: '99' }), ctx), /QuickBooks deposit account 99 must be migrated/)
})

// ---------------------------------------------------------------- expense
test('an expense whose source settlement account resolves stores it on settlement_account_id', async () => {
  await expenseModule.createRecord!(expRow({ settlementAccountSourceId: '103' }), ctx)
  assert.equal(db.expenses[0].settlement_account_id, 'acct-albilad')
})

test('an expense whose source settlement account cannot be resolved fails closed (throws, no record created)', async () => {
  await assert.rejects(
    () => expenseModule.createRecord!(expRow({ settlementAccountSourceId: '99' }), ctx),
    /QuickBooks settlement account 99 must be migrated/,
  )
  assert.equal(db.expenses.length, 0)
})

test('an expense with no source settlement account reference is created with settlement_account_id null (native fallback still applies at posting time)', async () => {
  await expenseModule.createRecord!(expRow({ settlementAccountSourceId: undefined }), ctx)
  assert.equal(db.expenses[0].settlement_account_id, null)
})

test('a native (non-QuickBooks) expense — no _realmId — never attempts to resolve a settlement account', async () => {
  await expenseModule.createRecord!(expRow({ _realmId: undefined, settlementAccountSourceId: '103' }), ctx)
  assert.equal(db.expenses[0].settlement_account_id, null, 'without a realm there is no QuickBooks account-mapping layer to resolve against')
})

// ---------------------------------------------------------------- invoice
test('an invoice line whose source revenue account cannot be resolved fails closed (throws before creating anything)', async () => {
  const invRow = {
    transactionNo: 'QB-1', customerName: 'Test Customer', status: 'SENT', currency: 'SAR', date: '2026-05-31',
    subtotal: '100', taxAmount: '0', total: '100', sourceId: '1', customerSourceId: '1', _realmId: REALM,
    lines: JSON.stringify([{ sourceLineId: '1', detailType: 'SalesItemLineDetail', description: 'Line 1', quantity: 1, unitPrice: 100, amount: 100, taxRate: 0, accountSourceId: '77', accountNo: '' }]),
  }
  await assert.rejects(
    () => invoiceModule.createRecord!(invRow, ctx),
    /QuickBooks revenue account 77 must be migrated before Invoice 1/,
  )
})
