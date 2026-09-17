/**
 * Regression for the NETKOM Expenses (transactions.module.ts) source-identity
 * collision bug, discovered during the Expense zero-value/negative-line
 * recovery: QuickBooks Purchase/Expense transactions carry a `DocNumber`
 * (mapped to `transactionNo`) that is NOT guaranteed globally unique — a
 * bank-feed-style auto-generated reference (e.g. "FT26029093544503") can be
 * shared by two genuinely different transactions.
 *
 * Root cause (`findDuplicate` / `findDuplicatesBatch`, both pre-fix): when a
 * row carried a QuickBooks `sourceId` that did NOT match any existing
 * `legacy_id`, the code still fell back to matching on `transactionNo`. For
 * NETKOM this merged two distinct QBO Purchase transactions into one:
 *
 *   - source 4308 (DocNumber FT26029093544503, TotalAmt 46,525.74)
 *     incorrectly matched existing source 4389 (same DocNumber, TotalAmt 4,500)
 *   - source 4295 (DocNumber FT26029002852695, TotalAmt 89,513.50)
 *     incorrectly matched existing source 4387 (same DocNumber, TotalAmt 42,300)
 *
 * The existing posted-ledger conflict guard in `updateRecord` correctly
 * refused to overwrite 4389/4387's ledger history, so no financial data was
 * corrupted — but 4308 and 4295 themselves were never created, because the
 * pipeline believed they already existed.
 *
 * The fix: once a row carries an authoritative QuickBooks `sourceId`, an
 * unmatched `legacy_id` lookup means "this is a new document" — full stop.
 * `transactionNo`/DocNumber is never consulted for such rows, matched or not.
 * Non-QuickBooks (CSV) rows carry no `sourceId` at all and are unaffected:
 * `transactionNo`/the module's `numberColumn` remains their only duplicate
 * signal. Mirrors the identical fix already shipped for Accounts
 * (`accounts.module.ts` / `account.repository.supabase.ts` — sourceId never
 * falls back to `accountNo`), applied here at the `transactions.module.ts`
 * shared duplicate matcher used by every QuickBooks-sourced transaction kind
 * (`legacy:true`: invoices, bills, expenses, journal-entries, sales-receipts,
 * vendor-credits, customer-payments, vendor-payments).
 *
 * Run: npx tsx --test tests/integrations/quickbooks-transaction-source-identity-collision.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://transaction-identity-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const { buildMappedImportPayload } = requireModule('../../src/app/api/import-export/_lib/parse-import-body') as typeof import('../../src/app/api/import-export/_lib/parse-import-body')
const { detectDuplicates } = requireModule('../../src/lib/import-export/duplicate/duplicate-detector') as typeof import('../../src/lib/import-export/duplicate/duplicate-detector')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')

const expensesModule = transactionModuleMap.get('expenses')!
const billsModule = transactionModuleMap.get('bills')!
const invoicesModule = transactionModuleMap.get('invoices')!

const COMPANY = '55555555-5555-5555-5555-555555555555'

/** Identity mapping for every declared transaction field — matches what an
 * auto-mapper produces for a well-formed QuickBooks page. `sourceId` IS a
 * declared field for this module (unlike Accounts pre-fix), so it survives
 * `applyColumnMapping` unconditionally; included here for completeness/parity
 * with the real mapping shape. */
function identityMapping(module: { fields: { key: string }[] }) {
  return Object.fromEntries(module.fields.map((f) => [f.key, f.key]))
}

/** Mirrors the mapped-row shape `quickbooks.adapter.ts` produces for a Purchase (Expense). */
function qbExpenseRow(sourceId: string, docNumber: string, total: number, extra: Record<string, unknown> = {}) {
  return {
    sourceId, transactionNo: docNumber, date: '2026-01-29', status: 'APPROVED', currency: 'SAR',
    total, taxAmount: 0, lines: '[]',
    _quickbooksId: sourceId, _quickbooksEntity: 'Purchase', _realmId: 'realm-1',
    ...extra,
  }
}

type Row = Record<string, unknown>
let rows: Row[] = []
let table = 'expenses'

function eq(url: URL, name: string) { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }
function inList(url: URL, name: string) {
  const v = url.searchParams.get(name)
  if (!v?.startsWith('in.(') || !v.endsWith(')')) return null
  return v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''))
}

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const reqTable = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (reqTable !== table) return json([])

    const companyId = eq(url, 'company_id')
    const legacyIdEq = eq(url, 'legacy_id'); const legacyIdIn = inList(url, 'legacy_id')
    const numberCol = table === 'bills' ? 'bill_no' : table === 'invoices' ? 'invoice_no' : 'expense_no'
    const numberEq = eq(url, numberCol); const numberIn = inList(url, numberCol)

    if (method === 'GET') {
      let matches = rows.filter((r) => r.company_id === companyId)
      if (legacyIdEq) matches = matches.filter((r) => r.legacy_id === legacyIdEq)
      if (legacyIdIn) matches = matches.filter((r) => legacyIdIn.includes(String(r.legacy_id)))
      if (numberEq) matches = matches.filter((r) => r[numberCol] === numberEq)
      if (numberIn) matches = matches.filter((r) => numberIn.includes(String(r[numberCol])))
      return json(matches)
    }
    return json([])
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => { rows = []; table = 'expenses' })

function run<T>(fn: () => Promise<T>): Promise<T> {
  return withCompanyContext(COMPANY, fn)
}

function seedExisting(id: string, legacyId: string, numberCol: string, number: string, total: number) {
  const now = new Date().toISOString()
  rows.push({ id, company_id: COMPANY, legacy_id: legacyId, [numberCol]: number, total, status: 'APPROVED', deleted_at: null, created_at: now, updated_at: now })
}

// --- TEST 1 ---------------------------------------------------------------
test('two QuickBooks Expenses with different sourceId but the same DocNumber/date are treated as distinct documents', async () => {
  await run(async () => {
    // The literal NETKOM collision: 4389 already exists; 4308 shares its DocNumber.
    seedExisting('native-4389', '4389', 'expense_no', 'FT26029093544503', 4500)

    const dup4308 = await expensesModule.findDuplicate!(qbExpenseRow('4308', 'FT26029093544503', 46525.74), { companyId: COMPANY, userId: 'user-1' } as never)
    assert.equal(dup4308, null, '4308 must NOT match 4389 merely because they share a DocNumber')
  })
})

test('duplicateKeys batch path: transactionNo fallback never fires when sourceId is present, matched or not', async () => {
  await run(async () => {
    seedExisting('native-4389', '4389', 'expense_no', 'FT26029093544503', 4500)
    seedExisting('native-4387', '4387', 'expense_no', 'FT26029002852695', 42300)

    const row4308 = { rowNumber: 1, source: {}, mapped: qbExpenseRow('4308', 'FT26029093544503', 46525.74) }
    const row4295 = { rowNumber: 2, source: {}, mapped: qbExpenseRow('4295', 'FT26029002852695', 89513.5) }
    const matches = await expensesModule.findDuplicatesBatch!([row4308, row4295], { companyId: COMPANY, userId: 'user-1' } as never)
    assert.equal(matches.length, 0, 'neither colliding row may resolve to an existing id via transactionNo')
  })
})

// --- TEST 2 ---------------------------------------------------------------
test('a QuickBooks sourceId that matches an existing legacy_id resolves normally (unchanged behavior)', async () => {
  await run(async () => {
    seedExisting('native-4389', '4389', 'expense_no', 'FT26029093544503', 4500)

    const dup = await expensesModule.findDuplicate!(qbExpenseRow('4389', 'FT26029093544503', 4500), { companyId: COMPANY, userId: 'user-1' } as never)
    assert.ok(dup, 'a genuine re-import of the same QBO document must still match')
    assert.equal(dup!.id, 'native-4389')
    assert.deepEqual(dup!.matchedOn, ['sourceId'])
  })
})

// --- TEST 3 ---------------------------------------------------------------
test('sourceId present + no legacy_id match + transactionNo DOES match an existing row => NEW, fallback never occurs', async () => {
  await run(async () => {
    seedExisting('native-4389', '4389', 'expense_no', 'FT26029093544503', 4500)

    const dup = await expensesModule.findDuplicate!(qbExpenseRow('4308', 'FT26029093544503', 46525.74), { companyId: COMPANY, userId: 'user-1' } as never)
    assert.equal(dup, null, 'must be treated as a brand-new document, never matched via the colliding transactionNo')

    const batchMatches = await expensesModule.findDuplicatesBatch!(
      [{ rowNumber: 1, source: {}, mapped: qbExpenseRow('4308', 'FT26029093544503', 46525.74) }],
      { companyId: COMPANY, userId: 'user-1' } as never,
    )
    assert.equal(batchMatches.length, 0)
  })
})

// --- TEST 4: real production path, not a mocked helper --------------------
test('end-to-end through buildMappedImportPayload -> applyColumnMapping -> detectDuplicates -> findDuplicatesBatch: 4308/4295 resolve as NEW, not merged into 4389/4387', async () => {
  await run(async () => {
    seedExisting('native-4389', '4389', 'expense_no', 'FT26029093544503', 4500)
    seedExisting('native-4387', '4387', 'expense_no', 'FT26029002852695', 42300)

    const mapping = identityMapping(expensesModule)
    const raw4308 = qbExpenseRow('4308', 'FT26029093544503', 46525.74)
    const raw4295 = qbExpenseRow('4295', 'FT26029002852695', 89513.5)
    const raw4389Reimport = qbExpenseRow('4389', 'FT26029093544503', 4500) // genuine re-import of the existing doc

    const { mappedRows } = buildMappedImportPayload(expensesModule, { rows: [raw4308, raw4295, raw4389Reimport], mapping })
    assert.equal(mappedRows[0].mapped.sourceId, '4308', 'sourceId must survive the real column-mapping step')
    assert.equal(mappedRows[1].mapped.sourceId, '4295')
    assert.equal(mappedRows[2].mapped.sourceId, '4389')

    const matches = await detectDuplicates(expensesModule, mappedRows, { companyId: COMPANY, userId: 'user-1' } as never)
    const byRow = new Map(matches.map((m) => [m.rowNumber, m]))

    assert.equal(byRow.has(mappedRows[0].rowNumber), false, '4308 must resolve as a NEW record end-to-end (no duplicate match)')
    assert.equal(byRow.has(mappedRows[1].rowNumber), false, '4295 must resolve as a NEW record end-to-end (no duplicate match)')
    const match4389 = byRow.get(mappedRows[2].rowNumber)
    assert.ok(match4389, 'the genuine 4389 re-import must still be recognized as a duplicate')
    assert.equal(match4389!.existingId, 'native-4389')
    assert.deepEqual(match4389!.matchedOn, ['sourceId'])
  })
})

test('non-QuickBooks CSV row with no sourceId still matches by transactionNo/numberColumn (unaffected by the fix)', async () => {
  await run(async () => {
    seedExisting('native-csv-1', '', 'expense_no', 'CHK-1001', 250)
    rows[0].legacy_id = null

    const mapping = identityMapping(expensesModule)
    const csvRow = { transactionNo: 'CHK-1001', date: '2026-01-01', status: 'APPROVED', currency: 'SAR', total: 250, taxAmount: 0, lines: '[]' }
    const { mappedRows } = buildMappedImportPayload(expensesModule, { rows: [csvRow], mapping })
    assert.equal(mappedRows[0].mapped.sourceId, undefined, 'a plain CSV row genuinely has no sourceId')

    const matches = await detectDuplicates(expensesModule, mappedRows, { companyId: COMPANY, userId: 'user-1' } as never)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].existingId, 'native-csv-1')
    assert.deepEqual(matches[0].matchedOn, ['transactionNo'])
  })
})

// --- Bills / Invoices share the same matcher -------------------------------
test('Bills: the same sourceId/DocNumber collision protection applies (shared matcher)', async () => {
  await run(async () => {
    table = 'bills'
    seedExisting('native-bill-9001', '9001', 'bill_no', 'REF-COLLIDE', 1000)
    const dup = await billsModule.findDuplicate!(qbExpenseRow('9002', 'REF-COLLIDE', 5000), { companyId: COMPANY, userId: 'user-1' } as never)
    assert.equal(dup, null, 'Bills must not merge a colliding bill_no across distinct sourceIds either')
  })
})

test('Invoices: the same sourceId/DocNumber collision protection applies (shared matcher)', async () => {
  await run(async () => {
    table = 'invoices'
    seedExisting('native-inv-501', '501', 'invoice_no', 'INV-COLLIDE', 800)
    const dup = await invoicesModule.findDuplicate!(qbExpenseRow('502', 'INV-COLLIDE', 3200), { companyId: COMPANY, userId: 'user-1' } as never)
    assert.equal(dup, null, 'Invoices must not merge a colliding invoice_no across distinct sourceIds either')
  })
})

// --- Interaction with the just-completed recovery --------------------------
test('a genuinely new sourceId (no collision) still creates/matches normally after the fix', async () => {
  await run(async () => {
    // Simulates one of the 1391 already-successful Expenses / one of the 5
    // just-recovered ones: sourceId present, legacy_id matches directly, no
    // DocNumber involved in the decision at all.
    seedExisting('native-3966', '3966', 'expense_no', 'ANY-DOC-NUMBER', 0)
    const dup = await expensesModule.findDuplicate!(qbExpenseRow('3966', 'ANY-DOC-NUMBER', 0), { companyId: COMPANY, userId: 'user-1' } as never)
    assert.ok(dup)
    assert.equal(dup!.id, 'native-3966')
    assert.deepEqual(dup!.matchedOn, ['sourceId'])
  })
})
