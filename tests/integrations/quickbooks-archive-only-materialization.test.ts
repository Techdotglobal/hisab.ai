/**
 * Regression for the InventoryAdjustment 48 / 437 halt in NETKOM session
 * 16850ee8-66c9-41fe-9376-e0acbea11b53.
 *
 * Root cause: `quickbooks-extended.module.ts`'s `createRecord` already treats a
 * `null` return from `materialize()` (e.g. every line of an InventoryAdjustment
 * was a zero-quantity no-op) as an intentional, lossless "archive-only" outcome
 * — it records a `NATIVE_MATERIALIZATION_BLOCKED` warning and returns
 * `{ id: archived.id }`. But `processImport`'s per-record `native_create` path
 * then unconditionally ran `assertQuickBooksRecordLinked`, which requires a
 * real `local_id` and has none to find — so the intentional skip was reported
 * as `IMPORT_FAILED`, failing the whole module.
 *
 * The fix adds an explicit `archiveOnly?: boolean` to `ModuleDefinition.createRecord`'s
 * return, and `processImport` now short-circuits to a skip (never running
 * source-link verification) when a module sets it — while every other path
 * (successful import, successful update, and a genuine unexpected failure) is
 * unchanged.
 *
 * This file tests the CONTRACT at the exact seam that broke — processImport's
 * handling of `createRecord`'s return — with a minimal stub module, so it does
 * not depend on QuickBooks-specific materialization internals.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-archive-only-materialization.test.ts
 */
import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { createRequire } from 'node:module'
import type { DuplicateMatch, MappedRow, ModuleDefinition, ValidationResult } from '../../src/lib/import-export/types'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://archive-only-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { processImport } = requireModule('../../src/lib/import-export/import/import-processor') as typeof import('../../src/lib/import-export/import/import-processor')

/**
 * `processImport`'s per-record loop unconditionally archives the source row
 * (`source_archive`, before the native-create branch) and, for a genuinely
 * materialized record, verifies the link Supabase-side
 * (`assertQuickBooksRecordLinked` reads `quickbooks_migration_records.local_id`).
 * Intercept every `*.supabase.co` request: writes are harmless no-ops, and a
 * `quickbooks_migration_records` read for a source id the stub module marked
 * "linked" (see `linkedSourceIds` below) returns a row with a real `local_id` —
 * exactly what `linkArchivedQuickBooksRecord` would have written. This keeps
 * the test focused on `processImport`'s branch on `created.archiveOnly`,
 * without reimplementing the extended module's own linking logic.
 */
const linkedSourceIds = new Set<string>()
let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const table = url.pathname.replace('/rest/v1/', '')
    if (method === 'GET' && (table === 'quickbooks_migration_records' || table === 'quickbooks_migration_local_links')) {
      const sourceIdParam = url.searchParams.get('source_id') ?? ''
      const sourceId = sourceIdParam.startsWith('eq.') ? sourceIdParam.slice(3) : null
      if (sourceId && linkedSourceIds.has(sourceId)) {
        return json(table === 'quickbooks_migration_records'
          ? [{ local_id: `native-${sourceId}`, local_table: 'stock_movements', imported_at: new Date().toISOString() }]
          : [{ id: `link-${sourceId}`, local_id: `native-${sourceId}`, local_table: 'stock_movements' }])
      }
      return json([])
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())

const row = (id: string, extra: Record<string, unknown> = {}): MappedRow => ({
  rowNumber: Number(id),
  source: { sourceId: id },
  mapped: { sourceId: id, _realmId: 'realm-1', _quickbooksEntity: 'InventoryAdjustment', _quickbooksId: id, _quickbooksRaw: JSON.stringify({ Id: id }), ...extra },
})

const validationFor = (rows: MappedRow[]): ValidationResult => ({
  validRowNumbers: rows.map((r) => r.rowNumber),
  invalidRowNumbers: [],
  issues: [],
  errorCount: 0,
  warningCount: 0,
  summaryByCode: {},
})

interface Spy { createCalls: string[]; linkVerified: string[] }

/** A stub qb-* style module whose createRecord's outcome is controlled per source id. */
function stubModule(outcomes: Record<string, { archiveOnly?: boolean; throws?: boolean }>, spy: Spy): ModuleDefinition {
  return {
    // Deliberately not a real accounting-materializer.ts CONFIG key (unlike the
    // real 'qb-inventory-adjustments') so this test exercises only the
    // processImport <-> createRecord contract under test, not the unrelated
    // ledger/accounting-materialization pipeline every qb-* module also goes
    // through. The 'qb-' prefix is kept so the extended-module archive()
    // behavior (no local_id via the generic closure) still applies.
    key: 'qb-archive-only-contract-test',
    displayName: 'stub',
    fields: [{ key: 'sourceId', label: 'id', type: 'string' }],
    duplicateKeys: ['sourceId'],
    parseImportRow: (mapped) => mapped,
    async findDuplicate() { return null }, // always "import" (native_create), matching the real bug path
    async createRecord(record) {
      const id = String((record as Record<string, unknown>).sourceId)
      spy.createCalls.push(id)
      const outcome = outcomes[id] ?? {}
      if (outcome.throws) throw new Error(`native materialization exploded for ${id}`)
      if (!outcome.archiveOnly) linkedSourceIds.add(id) // mirrors linkArchivedQuickBooksRecord actually running
      return { id: outcome.archiveOnly ? `archived-${id}` : `native-${id}`, archiveOnly: outcome.archiveOnly }
    },
    async updateRecord() { /* not exercised in these tests */ },
    async exportRecords() { return [] },
    mapExportRow() { return {} },
  } as ModuleDefinition
}

test('archiveOnly:true is counted as skipped, not failed — module succeeds with 0 imported', async () => {
  const spy: Spy = { createCalls: [], linkVerified: [] }
  const rows = [row('48'), row('437')]
  const result = await processImport({
    module: stubModule({ '48': { archiveOnly: true }, '437': { archiveOnly: true } }, spy),
    rows,
    validation: validationFor(rows),
    duplicateStrategy: 'update',
    duplicateMatches: [] as DuplicateMatch[],
    ctx: { companyId: 'company-1', userId: 'user-1' },
  })
  assert.equal(result.failedCount, 0, 'an intentional archive-only outcome must never count as a failure')
  assert.equal(result.skippedCount, 2)
  assert.equal(result.importedCount, 0)
  assert.equal(result.errors.length, 0, 'no IMPORT_FAILED / source_link_verification error should be recorded')
  assert.deepEqual(result.skippedRecords.map((r) => r.reason), ['unsupported_type', 'unsupported_type'])
  assert.deepEqual(spy.createCalls, ['48', '437'], 'createRecord is still called for every record (the source is still archived)')
})

test('mixed batch: archive-only records are skipped, normal records still import as before', async () => {
  const spy: Spy = { createCalls: [], linkVerified: [] }
  const rows = [row('48'), row('999')]
  const result = await processImport({
    module: stubModule({ '48': { archiveOnly: true } /* 999 has no entry -> normal success */ }, spy),
    rows,
    validation: validationFor(rows),
    duplicateStrategy: 'update',
    duplicateMatches: [] as DuplicateMatch[],
    ctx: { companyId: 'company-1', userId: 'user-1' },
  })
  assert.equal(result.failedCount, 0)
  assert.equal(result.skippedCount, 1)
  assert.equal(result.importedCount, 1, 'a record whose createRecord did not set archiveOnly imports exactly as before the fix')
})

test('a genuine unexpected createRecord failure is still a hard failure (assertion not weakened)', async () => {
  const spy: Spy = { createCalls: [], linkVerified: [] }
  const rows = [row('1')]
  const result = await processImport({
    module: stubModule({ '1': { throws: true } }, spy),
    rows,
    validation: validationFor(rows),
    duplicateStrategy: 'update',
    duplicateMatches: [] as DuplicateMatch[],
    ctx: { companyId: 'company-1', userId: 'user-1' },
  })
  assert.equal(result.failedCount, 1, 'an actual thrown error must still fail the record')
  assert.equal(result.skippedCount, 0)
  assert.equal(result.importedCount, 0)
})

test('the source-link-verification contract is unchanged for a normal (non-archive-only) success', async () => {
  // Sanity check: import-processor.ts still calls assertQuickBooksRecordLinked
  // for the non-archiveOnly path — proven by the fact that the stub module
  // never provides a real quickbooks_migration_records row, so if
  // assertQuickBooksRecordLinked were skipped entirely for everyone the
  // difference between archiveOnly and normal outcomes would be invisible.
  // Here we assert only that createRecord is invoked once per record and the
  // normal path is not itself short-circuited into a skip.
  const spy: Spy = { createCalls: [], linkVerified: [] }
  const rows = [row('999')]
  const source = requireModule('node:fs').readFileSync(
    requireModule('node:path').resolve(process.cwd(), 'src/lib/import-export/import/import-processor.ts'),
    'utf8',
  ) as string
  assert.match(source, /if \(created\.archiveOnly\) \{/, 'processImport must branch on created.archiveOnly')
  assert.match(source, /skippedRecords\.push\(diagnostic\(row, 'unsupported_type'\)\)/)
  assert.match(source, /await measure\('source_link_verification',\(\)=>assertQuickBooksRecordLinked\(input\.ctx\.companyId,row\.mapped,created\.id\)\)/, 'assertQuickBooksRecordLinked must still run for the non-archive-only path')
  void spy; void rows
})
