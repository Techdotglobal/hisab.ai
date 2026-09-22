/**
 * Regression for the second Phase 1 review gap: proves the invoice revenue-account fix end to end through the REAL
 * `getInvoiceRepository().create()` — not just adapter extraction or the fail-closed guard in isolation.
 *
 *   QBO SalesItemLineDetail.ItemAccountRef -> adapter (normalizeTransaction) -> transactions.module.ts createRecord
 *   -> getInvoiceRepository().create() -> buildLineRows -> invoice_lines.account_id
 *
 * Exercises the real `invoices` module `createRecord` against a minimal in-memory fake of the `*.supabase.co` REST
 * surface. `ctx.userId` is intentionally omitted so `resolveProfileUuid` short-circuits without a DB call — the same
 * created-by resolution used everywhere else in this codebase, not something specific to this fix.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-invoice-revenue-account-end-to-end.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://invoice-revenue-e2e-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { QuickBooksImportAdapter } = requireModule('../../src/lib/import-export/sources/quickbooks.adapter') as typeof import('../../src/lib/import-export/sources/quickbooks.adapter')
const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')
const invoicesModule = transactionModuleMap.get('invoices')!

const COMPANY = '88888888-8888-8888-8888-888888888888'
const REALM = 'realm-invoice-e2e-1'
type Row = Record<string, unknown>

const db = {
  customers: [{ id: 'c1111111-1111-1111-1111-111111111111', company_id: COMPANY, name: 'Test Customer', tax_id: null, deleted_at: null }],
  chart_of_accounts: [
    { id: 'a1111111-1111-1111-1111-111111111111', company_id: COMPANY, account_no: '41-4101', name: 'Sales', canonical_type: 'Income', is_active: true, deleted_at: null },
    // Deliberately present and would win an unordered/untyped default lookup — proves the STORED line uses the resolved
    // mapped account (Sales), never this one, once ItemAccountRef propagation is correct.
    { id: 'a2222222-2222-2222-2222-222222222222', company_id: COMPANY, account_no: '41-4103', name: 'Realized FX Gain', canonical_type: 'Income', is_active: true, deleted_at: null },
  ],
  quickbooks_migration_records: [
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Customer', source_id: '1', local_id: 'c1111111-1111-1111-1111-111111111111', local_table: 'customers' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '77', local_id: 'a1111111-1111-1111-1111-111111111111', local_table: 'chart_of_accounts' },
  ] as Row[],
  invoices: [] as Row[],
  invoice_lines: [] as Row[],
  reset() { this.invoices = []; this.invoice_lines = [] },
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

    if (table === 'quickbooks_migration_records' && method === 'GET') {
      const entityTypes = inList(url, 'entity_type'), sourceId = eq(url, 'source_id')
      const match = db.quickbooks_migration_records.find((r) => r.company_id === eq(url, 'company_id') && r.realm_id === eq(url, 'realm_id') && r.source_id === sourceId && (!entityTypes || entityTypes.includes(String(r.entity_type))))
      return json(match ? [match] : [])
    }
    if (table === 'customers' && method === 'GET') {
      const id = eq(url, 'id')
      return json(db.customers.find((c) => c.company_id === eq(url, 'company_id') && !c.deleted_at && c.id === id) ?? null)
    }
    if (table === 'chart_of_accounts' && method === 'GET') {
      const id = eq(url, 'id')
      const row = db.chart_of_accounts.find((a) => a.company_id === eq(url, 'company_id') && !a.deleted_at && a.id === id)
      return json(row ?? null)
    }
    if (table === 'invoices') {
      if (method === 'GET') return json([])
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.invoices.push(row); return json(row, 201) }
      if (method === 'PATCH') { const id = eq(url, 'id'); const row = db.invoices.find((i) => i.id === id); if (row) Object.assign(row, JSON.parse(String(init?.body ?? '{}'))); return json(row ? [row] : []) }
    }
    if (table === 'invoice_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '[]')) as Row[]
      const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: randomUUID(), ...r }))
      db.invoice_lines.push(...rows)
      return json(rows, 201)
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => db.reset())

const ctx = { companyId: COMPANY } as never // no userId: resolveProfileUuid(undefined) short-circuits without a DB call

test('a QuickBooks invoice line with ItemAccountRef resolves through the adapter, createRecord, and the real invoice repository to the correct destination revenue account', async () => {
  // The exact archived shape: SalesItemLineDetail nests ItemAccountRef alongside ItemRef.
  const rawInvoice = {
    Id: '3411', DocNumber: 'INV-3411', TotalAmt: 7393.65, TxnDate: '2026-05-31',
    CustomerRef: { value: '1' }, TxnTaxDetail: { TotalTax: 964.39 },
    Line: [{ Amount: 6429.26, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' }, ItemAccountRef: { value: '77', name: 'Sales' }, Qty: 1, UnitPrice: 6429.26 } }],
  }
  const mapped = new QuickBooksImportAdapter().normalizeRecords('invoices', [rawInvoice], REALM)[0] as Record<string, unknown>
  await withCompanyContext(COMPANY, () => invoicesModule.createRecord!(mapped, ctx))

  assert.equal(db.invoices.length, 1)
  assert.equal(db.invoice_lines.length, 1)
  const line = db.invoice_lines[0]
  assert.equal(line.account_id, 'a1111111-1111-1111-1111-111111111111', 'must be the QuickBooks-mapped Sales account')
  assert.notEqual(line.account_id, 'a2222222-2222-2222-2222-222222222222', 'must never be the unordered/untyped default that used to win')

  const invoice = db.invoices[0]
  assert.equal(Number(invoice.total), 7393.65, 'the stored invoice total must equal QuickBooks TotalAmt, VAT included')
  assert.equal(Number(invoice.subtotal), 6429.26)
  assert.equal(Number(invoice.tax_amount), 964.39)
})

test('an invoice line whose ItemAccountRef points at an account not yet migrated to chart_of_accounts fails closed before any invoice is created', async () => {
  const rawInvoice = {
    Id: '9999', DocNumber: 'INV-9999', TotalAmt: 100, TxnDate: '2026-05-31',
    CustomerRef: { value: '1' },
    Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' }, ItemAccountRef: { value: '999', name: 'Unmapped' } } }],
  }
  const mapped = new QuickBooksImportAdapter().normalizeRecords('invoices', [rawInvoice], REALM)[0] as Record<string, unknown>
  await assert.rejects(
    () => withCompanyContext(COMPANY, () => invoicesModule.createRecord!(mapped, ctx)),
    /QuickBooks revenue account 999 must be migrated before Invoice 9999/,
  )
  assert.equal(db.invoices.length, 0)
  assert.equal(db.invoice_lines.length, 0)
})
