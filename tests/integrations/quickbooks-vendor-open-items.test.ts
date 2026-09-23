/**
 * Phase 2 items 2/3: a JournalEntryLineDetail or Purchase (expense) line that posts to Accounts Payable and names a
 * vendor has, until now, been invisible outside the general ledger — no AP aging entry, no vendor statement line, no
 * way for a vendor payment to allocate against it. The JE/expense itself remains the SOLE ledger posting (no new GL
 * entries here); `vendor_open_items` is a pure subledger index. See src/lib/accounting/vendor-open-items.ts and
 * supabase/migrations/075_vendor_open_items.sql (authored, not applied).
 *
 * This file exercises the REAL `QuickBooksImportAdapter.normalizeRecords`, the real `journal-entries`/`expenses`
 * module `createRecord`, and the real `createOrUpdateVendorOpenItem` against a minimal in-memory fake of the
 * `*.supabase.co` REST surface.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-vendor-open-items.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://vendor-open-items-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { QuickBooksImportAdapter } = requireModule('../../src/lib/import-export/sources/quickbooks.adapter') as typeof import('../../src/lib/import-export/sources/quickbooks.adapter')
const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')
const { createOrUpdateVendorOpenItem, resolveVendorOpenItem } = requireModule('../../src/lib/accounting/vendor-open-items') as typeof import('../../src/lib/accounting/vendor-open-items')
const journalModule = transactionModuleMap.get('journal-entries')!
const expenseModule = transactionModuleMap.get('expenses')!

const COMPANY = '88888888-8888-8888-8888-888888888888'
const REALM = 'realm-vendor-open-items-1'
const VENDOR_LOCAL_ID = 'c4444444-4444-4444-4444-444444444441'
type Row = Record<string, unknown>

const db = {
  chart_of_accounts: [
    { id: 'a4444444-4444-4444-4444-444444444441', company_id: COMPANY, account_no: '22-2201-01', name: 'Accounts Payable', canonical_type: 'Liability', is_active: true, deleted_at: null },
    { id: 'a4444444-4444-4444-4444-444444444442', company_id: COMPANY, account_no: '11-1101', name: 'Bank', canonical_type: 'Asset', is_active: true, deleted_at: null },
    { id: 'a4444444-4444-4444-4444-444444444443', company_id: COMPANY, account_no: '51-5101', name: 'Office Rent Expense', canonical_type: 'Expense', is_active: true, deleted_at: null },
  ],
  quickbooks_migration_records: [
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '330', local_id: 'a4444444-4444-4444-4444-444444444441', local_table: 'chart_of_accounts', source_payload: { AccountType: 'Accounts Payable' } },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '103', local_id: 'a4444444-4444-4444-4444-444444444442', local_table: 'chart_of_accounts', source_payload: { AccountType: 'Bank' } },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '410', local_id: 'a4444444-4444-4444-4444-444444444443', local_table: 'chart_of_accounts', source_payload: { AccountType: 'Expense' } },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Vendor', source_id: '77', local_id: VENDOR_LOCAL_ID, local_table: 'vendors', source_payload: { DisplayName: 'Acme Supplies' } },
  ] as Row[],
  journal_entries: [] as Row[],
  journal_lines: [] as Row[],
  expenses: [] as Row[],
  expense_lines: [] as Row[],
  vendor_open_items: [] as Row[],
  reset() { this.journal_entries = []; this.journal_lines = []; this.expenses = []; this.expense_lines = []; this.vendor_open_items = [] },
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
    if (table === 'chart_of_accounts' && method === 'GET') {
      const matches = db.chart_of_accounts.filter((a) => a.company_id === eq(url, 'company_id') && a.is_active && !a.deleted_at)
      const ids = inList(url, 'id')
      if (ids) return json(matches.filter((a) => ids.includes(a.id)))
      return json(matches[0] ?? null)
    }
    if (table === 'journal_entries') {
      if (method === 'GET') return json([])
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.journal_entries.push(row); return json(row, 201) }
      if (method === 'DELETE') { const id = eq(url, 'id'); db.journal_entries = db.journal_entries.filter((r) => r.id !== id); return json([]) }
    }
    if (table === 'journal_lines') {
      if (method === 'DELETE') { const journalId = eq(url, 'journal_id'); db.journal_lines = db.journal_lines.filter((l) => l.journal_id !== journalId); return json([]) }
      if (method === 'POST') { const body = JSON.parse(String(init?.body ?? '[]')) as Row[]; const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: randomUUID(), ...r })); db.journal_lines.push(...rows); return json(rows, 201) }
    }
    if (table === 'expenses') {
      if (method === 'GET') return json([])
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.expenses.push(row); return json(row, 201) }
      if (method === 'DELETE') { const id = eq(url, 'id'); db.expenses = db.expenses.filter((r) => r.id !== id); return json([]) }
    }
    if (table === 'expense_lines') {
      if (method === 'DELETE') { const expenseId = eq(url, 'expense_id'); db.expense_lines = db.expense_lines.filter((l) => l.expense_id !== expenseId); return json([]) }
      if (method === 'POST') { const body = JSON.parse(String(init?.body ?? '[]')) as Row[]; const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: randomUUID(), ...r })); db.expense_lines.push(...rows); return json(rows, 201) }
    }
    if (table === 'vendor_open_items') {
      if (method === 'GET') {
        let matches = db.vendor_open_items.filter((r) =>
          r.company_id === eq(url, 'company_id') &&
          (eq(url, 'source_system') === null || r.source_system === eq(url, 'source_system')) &&
          (eq(url, 'source_type') === null || r.source_type === eq(url, 'source_type')) &&
          (eq(url, 'source_reference') === null || r.source_reference === eq(url, 'source_reference')) &&
          (eq(url, 'vendor_id') === null || r.vendor_id === eq(url, 'vendor_id')),
        )
        if (url.searchParams.get('deleted_at') === 'is.null') matches = matches.filter((r) => !r.deleted_at)
        if (url.searchParams.get('balance') === 'gt.0') matches = matches.filter((r) => Number(r.balance) > 0)
        return json(matches)
      }
      if (method === 'POST') { const row = { id: randomUUID(), deleted_at: null, ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.vendor_open_items.push(row); return json(row, 201) }
      if (method === 'PATCH') {
        const id = eq(url, 'id')
        const patch = JSON.parse(String(init?.body ?? '{}')) as Row
        const row = db.vendor_open_items.find((r) => r.id === id)
        if (!row) return json(null, 404)
        Object.assign(row, patch)
        return json(row, 200)
      }
    }
    if (table === 'ledger_entries' && method === 'GET') return json([])
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => db.reset())

const ctx = { companyId: COMPANY } as never

function jeWithVendorApLine(id = '2001') {
  return {
    Id: id, DocNumber: `JE-${id}`, TxnDate: '2024-06-01',
    Line: [
      { Id: '0', Amount: 2000, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '330' }, Entity: { Type: 'Vendor', EntityRef: { value: '77', name: 'Acme Supplies' } } } },
      { Id: '1', Amount: 2000, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '410' } } },
    ],
  }
}
async function createJe(raw: Row) {
  const mapped = new QuickBooksImportAdapter().normalizeRecords('journal-entries', [raw], REALM)[0] as Record<string, unknown>
  return withCompanyContext(COMPANY, () => journalModule.createRecord!(mapped, ctx))
}
async function createExpense(raw: Row) {
  const mapped = new QuickBooksImportAdapter().normalizeRecords('expenses', [raw], REALM)[0] as Record<string, unknown>
  return withCompanyContext(COMPANY, () => expenseModule.createRecord!(mapped, ctx))
}

// ---------------------------------------------------------------- JE AP open item
test('a JE AP-line naming a vendor creates a PAYABLE open item, and the JE remains the only ledger posting', async () => {
  const result = await createJe(jeWithVendorApLine())
  assert.equal(db.journal_lines.length, 2, 'no new GL line is added for the open item — the JE is unchanged')
  assert.equal(db.vendor_open_items.length, 1)
  const item = db.vendor_open_items[0]
  assert.equal(item.vendor_id, VENDOR_LOCAL_ID)
  assert.equal(item.direction, 'PAYABLE', 'the AP line is a Credit, i.e. a vendor liability')
  assert.equal(Number(item.total), 2000)
  assert.equal(Number(item.balance), 2000)
  assert.equal(item.source_type, 'JOURNAL_ENTRY')
  assert.equal(item.source_id, result.id)
})

test('a JE AP-line that is a Debit (vendor-credit-like reduction) creates a CREDIT-direction open item', async () => {
  const raw = { Id: '2002', DocNumber: 'JE-2002', TxnDate: '2024-06-01', Line: [
    { Id: '0', Amount: 500, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '330' }, Entity: { Type: 'Vendor', EntityRef: { value: '77' } } } },
    { Id: '1', Amount: 500, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '103' } } },
  ] }
  await createJe(raw)
  assert.equal(db.vendor_open_items.length, 1)
  assert.equal(db.vendor_open_items[0].direction, 'CREDIT')
})

test('a JE line posting to a non-AP account, even with a vendor entity, creates no open item', async () => {
  const raw = { Id: '2003', DocNumber: 'JE-2003', TxnDate: '2024-06-01', Line: [
    { Id: '0', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '410' }, Entity: { Type: 'Vendor', EntityRef: { value: '77' } } } },
    { Id: '1', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '103' } } },
  ] }
  await createJe(raw)
  assert.equal(db.vendor_open_items.length, 0)
})

test('a JE AP-line with no Entity (no vendor) creates no open item', async () => {
  const raw = { Id: '2004', DocNumber: 'JE-2004', TxnDate: '2024-06-01', Line: [
    { Id: '0', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '330' } } },
    { Id: '1', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '410' } } },
  ] }
  await createJe(raw)
  assert.equal(db.vendor_open_items.length, 0)
})

test('an unmigrated vendor on a JE AP-line fails closed', async () => {
  const raw = { Id: '2005', DocNumber: 'JE-2005', TxnDate: '2024-06-01', Line: [
    { Id: '0', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '330' }, Entity: { Type: 'Vendor', EntityRef: { value: '999' } } } },
    { Id: '1', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '410' } } },
  ] }
  await assert.rejects(() => createJe(raw), /QuickBooks vendor 999 must be migrated/)
})

// ---------------------------------------------------------------- expense AP open item
test('an expense (Purchase) AP-line resolves vendor identity from the header, not per-line, and creates a PAYABLE open item', async () => {
  const raw = {
    Id: '3001', DocNumber: 'EXP-3001', TxnDate: '2024-06-01', TotalAmt: 1000,
    VendorRef: { value: '77', name: 'Acme Supplies' },
    Line: [{ Id: '0', Amount: 1000, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '330' } } }],
  }
  const result = await createExpense(raw)
  assert.equal(db.vendor_open_items.length, 1)
  const item = db.vendor_open_items[0]
  assert.equal(item.vendor_id, VENDOR_LOCAL_ID)
  assert.equal(item.direction, 'PAYABLE')
  assert.equal(Number(item.total), 1000)
  assert.equal(item.source_type, 'EXPENSE')
  assert.equal(item.source_id, result.id)
})

test('an expense with no AP line (ordinary settlement-account expense) creates no open item', async () => {
  const raw = {
    Id: '3002', DocNumber: 'EXP-3002', TxnDate: '2024-06-01', TotalAmt: 250,
    VendorRef: { value: '77', name: 'Acme Supplies' },
    AccountRef: { value: '103' },
    Line: [{ Id: '0', Amount: 250, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '410' } } }],
  }
  await createExpense(raw)
  assert.equal(db.vendor_open_items.length, 0)
})

// ---------------------------------------------------------------- idempotency / conflict
test('re-materializing the same JE source id updates the existing open item in place rather than duplicating it', async () => {
  await createOrUpdateVendorOpenItem({ companyId: COMPANY, vendorId: VENDOR_LOCAL_ID, direction: 'PAYABLE', sourceType: 'JOURNAL_ENTRY', sourceId: randomUUID(), sourceReference: '2001:0', date: new Date('2024-06-01'), currency: 'SAR', total: 2000 })
  assert.equal(db.vendor_open_items.length, 1)
  await createOrUpdateVendorOpenItem({ companyId: COMPANY, vendorId: VENDOR_LOCAL_ID, direction: 'PAYABLE', sourceType: 'JOURNAL_ENTRY', sourceId: randomUUID(), sourceReference: '2001:0', date: new Date('2024-06-01'), currency: 'SAR', total: 2000 })
  assert.equal(db.vendor_open_items.length, 1, 'same source reference must not create a second row')
})

test('a source whose amount changed after payments were already allocated against it fails closed', async () => {
  const created = await createOrUpdateVendorOpenItem({ companyId: COMPANY, vendorId: VENDOR_LOCAL_ID, direction: 'PAYABLE', sourceType: 'JOURNAL_ENTRY', sourceId: randomUUID(), sourceReference: '2001:0', date: new Date('2024-06-01'), currency: 'SAR', total: 2000 })
  const row = db.vendor_open_items.find((r) => r.id === created.id)!
  row.applied_amount = 500
  await assert.rejects(
    () => createOrUpdateVendorOpenItem({ companyId: COMPANY, vendorId: VENDOR_LOCAL_ID, direction: 'PAYABLE', sourceType: 'JOURNAL_ENTRY', sourceId: randomUUID(), sourceReference: '2001:0', date: new Date('2024-06-01'), currency: 'SAR', total: 3000 }),
    /resolve the synchronization conflict/,
  )
})

test('resolveVendorOpenItem finds an item by its source reference', async () => {
  await createOrUpdateVendorOpenItem({ companyId: COMPANY, vendorId: VENDOR_LOCAL_ID, direction: 'PAYABLE', sourceType: 'JOURNAL_ENTRY', sourceId: randomUUID(), sourceReference: '2001:0', date: new Date('2024-06-01'), currency: 'SAR', total: 2000 })
  const found = await resolveVendorOpenItem(COMPANY, 'JOURNAL_ENTRY', '2001:0')
  assert.ok(found)
  assert.equal(Number(found!.total), 2000)
  assert.equal(await resolveVendorOpenItem(COMPANY, 'JOURNAL_ENTRY', 'does-not-exist'), null)
})
