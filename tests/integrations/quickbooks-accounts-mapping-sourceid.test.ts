/**
 * Regression for the NETKOM Accounts corruption caused by `sourceId` being
 * silently stripped by column mapping, one layer above the `accounts.module.ts`
 * duplicate-matching fix.
 *
 * The real production pipeline for a QuickBooks Accounts page is:
 *
 *   buildMappedImportPayload(accountsModule, body)
 *     -> applyColumnMapping(rows, mapping)        [mapping/auto-mapper.ts]
 *     -> coerceMappedRows / validateMappedRows
 *   -> detectDuplicates(accountsModule, mappedRows, ctx)
 *     -> accountsModule.findDuplicatesBatch(rows, ctx)
 *
 * `applyColumnMapping` builds `row.mapped` from scratch, keeping only fields
 * present in the (auto-generated) column `mapping` and fields satisfying
 * `isProtectedMigrationField`. `sourceId` is a plain field name — not declared
 * in `ACCOUNT_FIELDS` (so no mapping entry is auto-generated for it) and,
 * before this fix, not in `PROTECTED_MIGRATION_FIELDS` either — so it was
 * silently dropped before `accounts.module.ts` ever saw it. Every earlier
 * "Accounts identity" regression test (quickbooks-accounts-identity-collision.test.ts)
 * called `accountsModule.findDuplicatesBatch`/`createRecord`/`updateRecord`
 * directly with hand-built `mapped` objects that already included `sourceId`,
 * so they never exercised this stripping step and gave false confidence.
 *
 * This test exercises the real `buildMappedImportPayload` -> `applyColumnMapping`
 * -> `detectDuplicates` chain end-to-end, proving `sourceId` now survives
 * mapping and that QBO 335 (active) and QBO 104 (deleted, same accountNo)
 * resolve to their own distinct existing native rows via legacy_id/sourceId,
 * not the mutable, reused `accountNo`.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-accounts-mapping-sourceid.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://accounts-mapping-sourceid-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { buildMappedImportPayload } = requireModule('../../src/app/api/import-export/_lib/parse-import-body') as typeof import('../../src/app/api/import-export/_lib/parse-import-body')
const { detectDuplicates } = requireModule('../../src/lib/import-export/duplicate/duplicate-detector') as typeof import('../../src/lib/import-export/duplicate/duplicate-detector')
const { isProtectedMigrationField, PROTECTED_MIGRATION_FIELDS } = requireModule('../../src/lib/import-export/mapping/auto-mapper') as typeof import('../../src/lib/import-export/mapping/auto-mapper')
const { accountsModule } = requireModule('../../src/lib/import-export/registry/modules/accounts.module') as typeof import('../../src/lib/import-export/registry/modules/accounts.module')
const { ACCOUNT_FIELDS } = requireModule('../../src/lib/import-export/registry/modules/accounts.fields') as typeof import('../../src/lib/import-export/registry/modules/accounts.fields')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')

const COMPANY = '22222222-2222-2222-2222-222222222222'

/** Identity mapping for every declared accounts field — matches what an
 * auto-mapper produces for a well-formed QuickBooks page; deliberately
 * excludes `sourceId` since it is not in `ACCOUNT_FIELDS`. */
const ACCOUNTS_IDENTITY_MAPPING = Object.fromEntries(ACCOUNT_FIELDS.map((f) => [f.key, f.key]))

/** Mirrors the raw string-keyed row `quickbooks.adapter.ts:normalizeRecords`
 * produces for an Account resource (every value already coerced to string). */
function qbAccountSourceRow(sourceId: string, accountNo: string, name: string, isActive: boolean, extra: Record<string, string> = {}) {
  return {
    sourceId,
    accountNo,
    name,
    fullName: name,
    accountType: 'Other Current Asset',
    subType: 'OtherCurrentAssets',
    isActive: String(isActive),
    _quickbooksId: sourceId,
    _quickbooksEntity: 'Account',
    _realmId: 'realm-1',
    ...extra,
  }
}

let rows: Record<string, unknown>[] = []
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
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (table !== 'chart_of_accounts') return json([])

    const companyId = eq(url, 'company_id')
    const legacyIdEq = eq(url, 'legacy_id'); const legacyIdIn = inList(url, 'legacy_id')
    const accountNoEq = eq(url, 'account_no'); const accountNoIn = inList(url, 'account_no')

    if (method === 'GET') {
      let matches = rows.filter((r) => r.company_id === companyId)
      if (legacyIdEq) matches = matches.filter((r) => r.legacy_id === legacyIdEq)
      if (legacyIdIn) matches = matches.filter((r) => legacyIdIn.includes(String(r.legacy_id)))
      if (accountNoEq) matches = matches.filter((r) => r.account_no === accountNoEq)
      if (accountNoIn) matches = matches.filter((r) => accountNoIn.includes(String(r.account_no)))
      return json(matches)
    }
    return json([])
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => { rows = [] })

test('PROTECTED_MIGRATION_FIELDS includes sourceId', () => {
  assert.ok(PROTECTED_MIGRATION_FIELDS.has('sourceId'))
  assert.ok(isProtectedMigrationField('sourceId'))
})

test('sourceId survives buildMappedImportPayload/applyColumnMapping for a QuickBooks Account row', () => {
  const raw335 = qbAccountSourceRow('335', '32-3202', 'Accounts Receivable (A/R)', true)
  const { mappedRows } = buildMappedImportPayload(accountsModule, { rows: [raw335], mapping: ACCOUNTS_IDENTITY_MAPPING })
  assert.equal(mappedRows.length, 1)
  // This is the exact assertion that fails under the pre-fix implementation:
  // applyColumnMapping drops `sourceId` because it has no mapping entry and
  // (pre-fix) is not in PROTECTED_MIGRATION_FIELDS.
  assert.equal(mappedRows[0].mapped.sourceId, '335', 'sourceId must survive column mapping unchanged')
  assert.equal(mappedRows[0].mapped.accountNo, '32-3202', 'normal mapped fields are unaffected')
})

test('end-to-end: QBO 335 (active) and QBO 104 (deleted, same accountNo) resolve via sourceId, not accountNo, through the real pipeline', async () => {
  await withCompanyContext(COMPANY, async () => {
    const now = new Date().toISOString()
    // Seed the two already-reconciled native rows (Phase-4 state): distinct
    // legacy_id, distinct account_no — exactly like the real repaired NETKOM data.
    rows.push({ id: 'native-335', company_id: COMPANY, legacy_id: '335', account_no: '32-3202', name: 'Accounts Receivable (A/R)', is_active: true, deleted_at: null, created_at: now, updated_at: now })
    rows.push({ id: 'native-104', company_id: COMPANY, legacy_id: '104', account_no: 'QB-104', name: 'ACCOUNTS RECEIVABLE (deleted)', is_active: false, deleted_at: null, created_at: now, updated_at: now })

    const raw335 = qbAccountSourceRow('335', '32-3202', 'Accounts Receivable (A/R)', true)
    const raw104 = qbAccountSourceRow('104', '32-3202', 'ACCOUNTS RECEIVABLE (deleted)', false) // same raw accountNo — the collision trigger

    const { mappedRows } = buildMappedImportPayload(accountsModule, { rows: [raw335, raw104], mapping: ACCOUNTS_IDENTITY_MAPPING })
    assert.equal(mappedRows[0].mapped.sourceId, '335')
    assert.equal(mappedRows[1].mapped.sourceId, '104')

    const matches = await detectDuplicates(accountsModule, mappedRows, { companyId: COMPANY, userId: 'user-1' } as never)
    const byRow = new Map(matches.map((m) => [m.rowNumber, m]))

    const match335 = byRow.get(mappedRows[0].rowNumber)
    const match104 = byRow.get(mappedRows[1].rowNumber)
    assert.ok(match335, 'QBO 335 must resolve to an existing row')
    assert.ok(match104, 'QBO 104 must resolve to an existing row')
    assert.equal(match335!.existingId, 'native-335', 'QBO 335 must resolve to its OWN native row via sourceId, not the accountNo it happens to share with 104')
    assert.equal(match104!.existingId, 'native-104', 'QBO 104 must resolve to its OWN archived native row via sourceId, never merging into 335\'s row')
    assert.notEqual(match335!.existingId, match104!.existingId, 'the two QuickBooks identities must never collapse onto the same native row')
    assert.deepEqual(match335!.matchedOn, ['sourceId'])
    assert.deepEqual(match104!.matchedOn, ['sourceId'])
  })
})

test('accountNo fallback still works end-to-end for a non-QuickBooks (CSV) row with no sourceId', async () => {
  await withCompanyContext(COMPANY, async () => {
    const now = new Date().toISOString()
    rows.push({ id: 'native-csv-1', company_id: COMPANY, legacy_id: null, account_no: 'CSV-100', name: 'Manual Bank Account', is_active: true, deleted_at: null, created_at: now, updated_at: now })

    const csvRow = { accountNo: 'CSV-100', name: 'Manual Bank Account', fullName: 'Manual Bank Account', accountType: 'Bank', subType: 'Bank', isActive: 'true' }
    const { mappedRows } = buildMappedImportPayload(accountsModule, { rows: [csvRow], mapping: ACCOUNTS_IDENTITY_MAPPING })
    assert.equal(mappedRows[0].mapped.sourceId, undefined, 'a plain CSV row genuinely has no sourceId')

    const matches = await detectDuplicates(accountsModule, mappedRows, { companyId: COMPANY, userId: 'user-1' } as never)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].existingId, 'native-csv-1')
    assert.deepEqual(matches[0].matchedOn, ['accountNo'])
  })
})
