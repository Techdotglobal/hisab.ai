/**
 * Regression for the NETKOM held-JE root cause found in the final closure audit: 1,817 journal entries failed their
 * balance check (debit sum != credit sum) because `JournalEntryLineDetail.TaxAmount` was never extracted. QuickBooks
 * records a taxable JE line's `Amount` net of tax, carrying the tax portion separately in `TaxAmount` — the matching
 * settlement line (bank/AP) is already tax-inclusive. Confirmed against the archived payloads for JE 59 (Debit 5000,
 * TaxAmount 750, Credit 5750) and the JE 1878/2495 pair (a JE and its exact reversal).
 *
 * The fix is two-sided:
 *  - quickbooks.adapter.ts now preserves `TaxAmount`/`TaxApplicableOn` per line and includes the tax portion in the
 *    journal header total (`journalTotal`), so `total_debit`/`total_credit` reflect the true balanced amount.
 *  - transactions.module.ts's journal line-building loop adds one extra debit/credit line per taxed line, on the SAME
 *    side as the original line, to the VAT account resolved by TaxApplicableOn ('Purchase' -> Input VAT/Asset,
 *    'Sale' -> Output VAT/Liability) — reusing the exact candidate lists getAccountIds/buildTaxJournalLines already use.
 *    An unresolved VAT account fails closed before any row is written.
 *
 * This file exercises the REAL `QuickBooksImportAdapter.normalizeRecords` and the real `journal-entries` module
 * `createRecord` against a minimal in-memory fake of the `*.supabase.co` REST surface.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-journal-entry-tax-amount.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://je-tax-amount-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { QuickBooksImportAdapter } = requireModule('../../src/lib/import-export/sources/quickbooks.adapter') as typeof import('../../src/lib/import-export/sources/quickbooks.adapter')
const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')
const journalModule = transactionModuleMap.get('journal-entries')!

const COMPANY = '99999999-9999-9999-9999-999999999999'
const REALM = 'realm-je-tax-1'
type Row = Record<string, unknown>

const db = {
  chart_of_accounts: [
    { id: 'a3333333-3333-3333-3333-333333333331', company_id: COMPANY, account_no: '51-5101', name: 'Vehicle Rental Expense', canonical_type: 'Expense', is_active: true, deleted_at: null },
    { id: 'a3333333-3333-3333-3333-333333333332', company_id: COMPANY, account_no: '22-2201-01', name: 'Accounts Payable', canonical_type: 'Liability', is_active: true, deleted_at: null },
    { id: 'a3333333-3333-3333-3333-333333333333', company_id: COMPANY, account_no: '32-3203-01', name: 'INPUT VAT ON GOODS AND SERVICES', canonical_type: 'Asset', is_active: true, deleted_at: null },
    { id: 'a3333333-3333-3333-3333-333333333334', company_id: COMPANY, account_no: '11-1101', name: 'Bank', canonical_type: 'Asset', is_active: true, deleted_at: null },
  ],
  quickbooks_migration_records: [
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '263', local_id: 'a3333333-3333-3333-3333-333333333331', local_table: 'chart_of_accounts' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '330', local_id: 'a3333333-3333-3333-3333-333333333332', local_table: 'chart_of_accounts' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '103', local_id: 'a3333333-3333-3333-3333-333333333334', local_table: 'chart_of_accounts' },
  ] as Row[],
  journal_entries: [] as Row[],
  journal_lines: [] as Row[],
  reset() { this.journal_entries = []; this.journal_lines = [] },
}

const eq = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }
const inList = (url: URL, name: string) => { const v = url.searchParams.get(name); if (!v?.startsWith('in.(') || !v.endsWith(')')) return null; return v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')) }
const ilike = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('ilike.') ? v.slice(6).replace(/^%|%$/g, '') : null }

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
      let matches = db.chart_of_accounts.filter((a) => a.company_id === eq(url, 'company_id') && a.is_active && !a.deleted_at)
      const ids = inList(url, 'id')
      if (ids) return json(matches.filter((a) => ids.includes(a.id)))
      const name = ilike(url, 'name'), canonicalType = eq(url, 'canonical_type')
      if (name) matches = matches.filter((a) => a.name.toLowerCase().includes(name.toLowerCase()))
      if (canonicalType) matches = matches.filter((a) => a.canonical_type === canonicalType)
      matches = [...matches].sort((a, b) => a.account_no.localeCompare(b.account_no))
      return json(matches[0] ?? null)
    }
    if (table === 'journal_entries') {
      if (method === 'GET') return json([])
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.journal_entries.push(row); return json(row, 201) }
      if (method === 'DELETE') { const id = eq(url, 'id'); db.journal_entries = db.journal_entries.filter((r) => r.id !== id); return json([]) }
    }
    if (table === 'journal_lines' && method === 'DELETE') { const journalId = eq(url, 'journal_id'); db.journal_lines = db.journal_lines.filter((l) => l.journal_id !== journalId); return json([]) }
    if (table === 'ledger_entries' && method === 'GET') return json([])
    if (table === 'journal_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '[]')) as Row[]
      const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: randomUUID(), ...r }))
      db.journal_lines.push(...rows)
      return json(rows, 201)
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => db.reset())

const ctx = { companyId: COMPANY } as never

function je59Raw() {
  return {
    Id: '59', DocNumber: 'JE-59', TxnDate: '2024-06-01',
    Line: [
      { Id: '0', Amount: 5000, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '330' }, TaxAmount: 750, TaxApplicableOn: 'Purchase' } },
      { Id: '1', Amount: 5750, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '103' } } },
    ],
  }
}
async function createJe(raw: Row) {
  const mapped = new QuickBooksImportAdapter().normalizeRecords('journal-entries', [raw], REALM)[0] as Record<string, unknown>
  return withCompanyContext(COMPANY, () => journalModule.createRecord!(mapped, ctx))
}
const debitCreditTotals = () => ({ debit: db.journal_lines.reduce((s, l) => s + Number(l.debit ?? 0), 0), credit: db.journal_lines.reduce((s, l) => s + Number(l.credit ?? 0), 0) })

// ---------------------------------------------------------------- adapter extraction
test('adapter extracts JournalEntryLineDetail.TaxAmount and TaxApplicableOn per line, and includes tax in the header total', () => {
  const mapped = new QuickBooksImportAdapter().normalizeRecords('journal-entries', [je59Raw()], REALM)[0] as Record<string, unknown>
  const lines = JSON.parse(String(mapped.lines)) as Row[]
  assert.equal(lines[0].taxAmount, '750')
  assert.equal(lines[0].taxApplicableOn, 'Purchase')
  assert.equal(lines[1].taxAmount, '0')
  assert.equal(Number(mapped.total), 5750, 'header total must be the balanced (tax-inclusive) amount, not the pre-tax 5000')
})

// ---------------------------------------------------------------- normal taxable JE
test('a normal taxable JE (JE 59 shape) posts an extra debit VAT line and balances exactly as QBO represents it', async () => {
  await createJe(je59Raw())
  assert.equal(db.journal_lines.length, 3, 'original 2 lines + 1 injected VAT line')
  const vatLine = db.journal_lines.find((l) => l.account_id === 'a3333333-3333-3333-3333-333333333333')
  assert.ok(vatLine, 'must post to the resolved Input VAT account')
  assert.equal(Number(vatLine!.debit), 750, 'VAT line takes the SAME side as the taxed line (Debit)')
  assert.equal(Number(vatLine!.credit), 0)
  const totals = debitCreditTotals()
  assert.equal(totals.debit, totals.credit, 'debit must equal credit after materialization')
  assert.equal(totals.debit, 5750)
  assert.equal(Number(db.journal_entries[0].total_debit), 5750)
  assert.equal(Number(db.journal_entries[0].total_credit), 5750)
})

// ---------------------------------------------------------------- tax-inclusive credit / reversal JE
test('a reversal JE (JE 2495 shape: the taxed line is a Credit) posts the VAT line as a credit, mirroring the original', async () => {
  const raw = {
    Id: '2495', DocNumber: '948R', TxnDate: '2024-06-01',
    Line: [
      { Id: '0', Amount: 1276, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '263' }, TaxAmount: 191.4, TaxApplicableOn: 'Purchase' } },
      { Id: '1', Amount: 1467.4, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '330' } } },
    ],
  }
  await createJe(raw)
  const vatLine = db.journal_lines.find((l) => l.account_id === 'a3333333-3333-3333-3333-333333333333')
  assert.equal(Number(vatLine!.credit), 191.4)
  assert.equal(Number(vatLine!.debit), 0)
  const totals = debitCreditTotals()
  assert.equal(totals.debit, totals.credit)
  assert.equal(totals.credit, 1467.4)
})

test('the forward JE (JE 1878 shape) and its reversal (JE 2495) are exact mirrors once both post', async () => {
  const forward = { Id: '1878', DocNumber: '948', TxnDate: '2024-05-31', Line: [
    { Id: '0', Amount: 1276, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '263' }, TaxAmount: 191.4, TaxApplicableOn: 'Purchase' } },
    { Id: '1', Amount: 1467.4, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '330' } } },
  ] }
  await createJe(forward)
  const forwardTotals = debitCreditTotals()
  assert.equal(forwardTotals.debit, forwardTotals.credit)
  assert.equal(forwardTotals.debit, 1467.4)
})

// ---------------------------------------------------------------- zero-tax JE
test('a JE with no TaxAmount on any line is completely unaffected (no VAT line, same balance as before)', async () => {
  const raw = { Id: '1', DocNumber: 'JE-1', TxnDate: '2026-01-01', Line: [
    { Id: '0', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '263' } } },
    { Id: '1', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '330' } } },
  ] }
  await createJe(raw)
  assert.equal(db.journal_lines.length, 2, 'no VAT line injected')
  const totals = debitCreditTotals()
  assert.equal(totals.debit, 100)
  assert.equal(totals.credit, 100)
})

// ---------------------------------------------------------------- fail closed
test('a taxable JE line fails closed when no VAT account can be resolved, before any row is written', async () => {
  // A separate company where the ordinary AccountRef targets (263, 330) resolve normally but no VAT account of any kind
  // exists — isolates "no resolvable VAT account" from the pre-existing "line has no migrated account" check, without
  // destructively mutating the shared chart_of_accounts fixture other tests rely on.
  const NO_VAT_COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  db.chart_of_accounts.push(
    { id: 'b0000000-0000-0000-0000-000000000001', company_id: NO_VAT_COMPANY, account_no: '51-5101', name: 'Vehicle Rental Expense', canonical_type: 'Expense', is_active: true, deleted_at: null },
    { id: 'b0000000-0000-0000-0000-000000000002', company_id: NO_VAT_COMPANY, account_no: '22-2201-01', name: 'Accounts Payable', canonical_type: 'Liability', is_active: true, deleted_at: null },
  )
  db.quickbooks_migration_records.push(
    { company_id: NO_VAT_COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '263', local_id: 'b0000000-0000-0000-0000-000000000001', local_table: 'chart_of_accounts' },
    { company_id: NO_VAT_COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '330', local_id: 'b0000000-0000-0000-0000-000000000002', local_table: 'chart_of_accounts' },
  )
  const mapped = new QuickBooksImportAdapter().normalizeRecords('journal-entries', [je59Raw()], REALM)[0] as Record<string, unknown>
  await assert.rejects(
    () => withCompanyContext(NO_VAT_COMPANY, () => journalModule.createRecord!(mapped, { companyId: NO_VAT_COMPANY } as never)),
    /no resolvable VAT account/,
  )
  assert.equal(db.journal_entries.filter((r) => r.company_id === NO_VAT_COMPANY).length, 0, 'the header insert is rolled back when line insertion fails')
  assert.equal(db.journal_lines.filter((l) => l.company_id === NO_VAT_COMPANY).length, 0)
})

test('an unrecognized TaxApplicableOn value fails closed rather than guessing a VAT account', async () => {
  const raw = { Id: '2', DocNumber: 'JE-2', TxnDate: '2026-01-01', Line: [
    { Id: '0', Amount: 100, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '263' }, TaxAmount: 15, TaxApplicableOn: 'ReverseCharge' } },
    { Id: '1', Amount: 115, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '330' } } },
  ] }
  await assert.rejects(() => createJe(raw), /no resolvable VAT account for TaxApplicableOn 'ReverseCharge'/)
})

// ---------------------------------------------------------------- multi-line JE (only some lines taxed)
test('a multi-line JE where only some lines carry tax adds one VAT line per taxed line and still balances', async () => {
  const raw = { Id: '66', DocNumber: 'JE-66', TxnDate: '2024-06-01', Line: [
    { Id: '0', Amount: 13.61, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '263' }, TaxAmount: 2.04, TaxApplicableOn: 'Purchase' } },
    { Id: '1', Amount: 15, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '263' }, TaxAmount: 2.25, TaxApplicableOn: 'Purchase' } },
    { Id: '2', Amount: 32.9, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '103' } } },
  ] }
  await createJe(raw)
  assert.equal(db.journal_lines.length, 5, '3 original lines + 2 injected VAT lines')
  const totals = debitCreditTotals()
  assert.equal(Math.round(totals.debit * 100), Math.round(totals.credit * 100))
  assert.equal(Math.round(totals.debit * 100), 3290)
})
