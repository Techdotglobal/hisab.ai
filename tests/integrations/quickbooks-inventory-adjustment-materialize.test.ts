/**
 * Exercises the REAL `qb-inventory-adjustments` extended-module `createRecord`
 * (the exact code that produced NETKOM's InventoryAdjustment 48 / 437 outcome),
 * proving:
 *   - a record whose only line is a zero-quantity no-op (`QtyDiff: 0`) is
 *     archived, its NATIVE_MATERIALIZATION_BLOCKED warning is recorded, and
 *     `createRecord` now returns `archiveOnly: true` (no stock_movements write
 *     attempted, no local link written);
 *   - a mixed record (one zero line + one real line) still materializes the
 *     real line as a stock movement and is NOT classified as archive-only;
 *   - a record whose item cannot be resolved is also archive-only (a distinct,
 *     also-legitimate reason for the same outcome) — never silently promoted
 *     to a fabricated success.
 *
 * `@/lib/inventory/movements` and `@/lib/inventory/journal-posting` are mocked
 * (their own DB-heavy internals are out of scope here); every other call goes
 * through the real `migration-store.ts` against a minimal in-memory fake of
 * the `*.supabase.co` REST surface, the same technique already used by
 * quickbooks-materialization-batching.test.ts.
 *
 * Run: npx tsx --test --experimental-test-module-mocks tests/integrations/quickbooks-inventory-adjustment-materialize.test.ts
 */
import assert from 'node:assert/strict'
import { test, mock, before, after } from 'node:test'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://inventory-adjustment-materialize-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const MOCKS: string | false =
  typeof (mock as { module?: unknown }).module === 'function' ? false : 'requires --experimental-test-module-mocks'

const COMPANY = 'company-inv-1'
const REALM = 'realm-inv-1'

/** In-memory `quickbooks_migration_records` / `_local_links` / `_warnings` / `stock_movements`. */
const db = {
  records: new Map<string, Record<string, unknown>>(), // key: entity_type|source_id
  links: [] as Array<Record<string, unknown>>,
  warnings: [] as Array<Record<string, unknown>>,
  movements: [] as Array<Record<string, unknown>>,
  reset() { this.records = new Map(); this.links = []; this.warnings = []; this.movements = [] },
}

/** Seeds a materialized QuickBooks Item so `resolveQuickBooksLocalId(['Item'],['inventory_items'])` finds it. */
function seedItem(sourceId: string, localId: string) {
  db.records.set(`Item|${sourceId}`, { entity_type: 'Item', source_id: sourceId, local_id: localId, local_table: 'inventory_items' })
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
    const eq = (name: string) => { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }
    // `.in('entity_type', [...])` / `.in('local_table', [...])` render as
    // `entity_type=in.(Item,Vendor)` — extract the candidate list.
    const inList = (name: string) => {
      const v = url.searchParams.get(name)
      if (!v?.startsWith('in.(') || !v.endsWith(')')) return null
      return v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''))
    }

    if (table === 'quickbooks_migration_records') {
      if (method === 'GET') {
        const sourceId = eq('source_id')
        const entityTypeEq = eq('entity_type')
        const entityTypeIn = inList('entity_type')
        const row = sourceId
          ? [...db.records.values()].find((r) => {
            if (r.source_id !== sourceId) return false
            if (entityTypeEq) return r.entity_type === entityTypeEq
            if (entityTypeIn) return entityTypeIn.includes(String(r.entity_type))
            return true
          })
          : undefined
        return json(row ? [row] : [])
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        db.records.set(`${body.entity_type}|${body.source_id}`, { ...db.records.get(`${body.entity_type}|${body.source_id}`), ...body })
        return json([{ id: 'archived-row', ...body }], 201)
      }
    }
    if (table === 'quickbooks_migration_local_links') {
      if (method === 'GET') return json([])
      if (method === 'POST') { db.links.push(JSON.parse(String(init?.body ?? '{}'))); return json(null, 201) }
    }
    if (table === 'quickbooks_migration_warnings') {
      if (method === 'POST') { db.warnings.push(JSON.parse(String(init?.body ?? '{}'))); return json(null, 201) }
    }
    if (table === 'stock_movements') {
      if (method === 'GET') return json([]) // no pre-existing movement
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())

let quickBooksExtendedModules: typeof import('../../src/lib/import-export/registry/modules/quickbooks-extended.module')['quickBooksExtendedModules']

before(async () => {
  if (MOCKS) return
  mock.module('server-only', { namedExports: {}, defaultExport: {} })
  mock.module('../../src/lib/inventory/movements', {
    namedExports: {
      processInventoryMovement: async (input: { inventoryItemId: string; quantity: number }) => ({
        movementId: `movement-${input.inventoryItemId}-${input.quantity}`,
        movementNo: 'MV-TEST',
        unitCost: 0,
        totalCost: 0,
      }),
    },
  })
  mock.module('../../src/lib/inventory/journal-posting', {
    namedExports: { postInventoryAdjustmentJournal: async () => {} },
  })
  ;({ quickBooksExtendedModules } = await import('../../src/lib/import-export/registry/modules/quickbooks-extended.module'))
})
after(() => { if (!MOCKS) mock.restoreAll() })

function inventoryAdjustmentModule() {
  const m = quickBooksExtendedModules.find((mod) => mod.key === 'qb-inventory-adjustments')
  if (!m) throw new Error('qb-inventory-adjustments module not found')
  return m
}

function row(id: string, raw: Record<string, unknown>) {
  return { _realmId: REALM, sourceId: id, _quickbooksId: id, _quickbooksRaw: JSON.stringify(raw) }
}

test('InventoryAdjustment with only a QtyDiff:0 line is archived, native materialization is skipped, warning recorded', { skip: MOCKS }, async () => {
  db.reset()
  seedItem('13', 'inv-item-13')
  const raw = {
    Id: '48', DocNumber: '8', TxnDate: '2023-08-02', AdjustAccountRef: { value: '367' },
    Line: [{ Id: '1', DetailType: 'ItemAdjustmentLineDetail', ItemAdjustmentLineDetail: { ItemRef: { value: '13' }, QtyDiff: 0 } }],
  }
  const result = await inventoryAdjustmentModule().createRecord(row('48', raw), { companyId: COMPANY, userId: 'user-1' })
  assert.equal(result.archiveOnly, true, 'a record whose every line is a zero-quantity no-op must be archive-only')
  assert.equal(db.movements.length, 0, 'no stock_movements write must be attempted')
  assert.equal(db.links.length, 0, 'no local link is written for an archive-only outcome')
  assert.ok(db.records.get('InventoryAdjustment|48'), 'the source row is still archived losslessly')
  const warning = db.warnings.find((w) => w.source_id === '48')
  assert.ok(warning, 'the existing NATIVE_MATERIALIZATION_BLOCKED warning must still be recorded')
  assert.equal(warning!.code, 'NATIVE_MATERIALIZATION_BLOCKED')
})

test('InventoryAdjustment with one zero line and one real line still materializes the real line (not archive-only)', { skip: MOCKS }, async () => {
  db.reset()
  seedItem('13', 'inv-item-13')
  seedItem('20', 'inv-item-20')
  const raw = {
    Id: '999', DocNumber: '9', TxnDate: '2023-08-02', AdjustAccountRef: { value: '367' },
    Line: [
      { Id: '1', DetailType: 'ItemAdjustmentLineDetail', ItemAdjustmentLineDetail: { ItemRef: { value: '13' }, QtyDiff: 0 } },
      { Id: '2', DetailType: 'ItemAdjustmentLineDetail', ItemAdjustmentLineDetail: { ItemRef: { value: '20' }, QtyDiff: 5 } },
    ],
  }
  const result = await inventoryAdjustmentModule().createRecord(row('999', raw), { companyId: COMPANY, userId: 'user-1' })
  assert.notEqual(result.archiveOnly, true, 'a record with at least one real line must not be classified as archive-only')
  assert.equal(db.links.length, 1, 'the real line materializes and is linked')
  assert.equal(db.warnings.find((w) => w.source_id === '999'), undefined, 'no blocked-materialization warning when a real line succeeded')
})

test('InventoryAdjustment referencing an unresolved item is archive-only (never a fabricated success)', { skip: MOCKS }, async () => {
  db.reset()
  // Item "77" intentionally NOT seeded -> unresolved.
  const raw = {
    Id: '437', DocNumber: '13', TxnDate: '2023-09-24', AdjustAccountRef: { value: '367' },
    Line: [{ Id: '1', DetailType: 'ItemAdjustmentLineDetail', ItemAdjustmentLineDetail: { ItemRef: { value: '77' }, QtyDiff: 4 } }],
  }
  const result = await inventoryAdjustmentModule().createRecord(row('437', raw), { companyId: COMPANY, userId: 'user-1' })
  assert.equal(result.archiveOnly, true, 'an unresolved item dependency must also resolve to archive-only, not a fabricated success')
  assert.equal(db.movements.length, 0)
  assert.equal(db.links.length, 0)
  const warning = db.warnings.find((w) => w.source_id === '437')
  assert.ok(warning, 'the blocked-materialization warning must still be recorded for this distinct cause')
})
