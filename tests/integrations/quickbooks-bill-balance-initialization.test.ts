/**
 * Regression for the NETKOM imported-bill balance defect.
 *
 * Root cause: the QuickBooks import built the `bills` header without `amount_paid`/`balance`. The DB defaults both to 0 and
 * only an allocation refresh (`replace_payment_allocations` -> `refresh_payment_document_balances`) corrects them, so an
 * imported bill that never received an allocation kept balance 0 while QuickBooks (and the GL) still owed it, and AP aging
 * (which filters balance > 0) omitted it. 14 of 180 NETKOM bills (SAR 528,874.84) were affected.
 *
 * This file exercises the REAL `bills` module `createRecord` against a minimal fake of the `*.supabase.co` REST surface, and
 * the pure guard planner used by the one-off production backfill.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-bill-balance-initialization.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://bill-balance-init-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const {
  billAllocationInvariant, planBillBalanceBackfill, REVIEWED_BILL_BACKFILL_TARGETS, REVIEWED_BILL_BACKFILL_TOTAL_CENTS,
} = requireModule('../../src/lib/import-export/quickbooks/bill-balance-backfill') as typeof import('../../src/lib/import-export/quickbooks/bill-balance-backfill')
const billsModule = transactionModuleMap.get('bills')!

const COMPANY = 'company-bill-balance-1'
const db = {
  vendors: [{ id: 'vendor-1', company_id: COMPANY, name: 'Test Vendor', deleted_at: null }],
  bills: [] as Record<string, unknown>[],
  bill_lines: [] as Record<string, unknown>[],
  reset() { this.bills = []; this.bill_lines = [] },
}
const eq = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }

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
    if (table === 'bills') {
      if (method === 'GET') return json([])
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>) }; db.bills.push(row); return json(row, 201) }
    }
    if (table === 'bill_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '[]')) as Record<string, unknown>[]
      const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: randomUUID(), ...r }))
      db.bill_lines.push(...rows)
      return json(rows, 201)
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => db.reset())

/** The mapped-row shape quickbooks.adapter.ts produces for a Bill (monetary values arrive as strings). */
function billRow(transactionNo: string, opts: { subtotal: string; tax: string; total: string; status?: string }) {
  return {
    transactionNo, vendorName: 'Test Vendor', status: opts.status ?? 'RECEIVED', currency: 'SAR', date: '2026-05-31',
    subtotal: opts.subtotal, taxAmount: opts.tax, total: opts.total,
    lines: JSON.stringify([{ sourceLineId: '1', detailType: 'AccountBasedExpenseLineDetail', description: 'Line 1', quantity: 1, unitPrice: Number(opts.subtotal), amount: Number(opts.subtotal), taxRate: 15 }]),
  }
}
const ctx = { companyId: COMPANY, userId: 'user-1' } as never

// ---------------------------------------------------------------- import fix
test('an imported bill is created fully open: amount_paid 0 and balance equal to its total', async () => {
  await billsModule.createRecord!(billRow('QB-5006', { subtotal: '119070.26', tax: '17862.54', total: '136932.80' }), ctx)
  assert.equal(db.bills.length, 1)
  assert.equal(db.bills[0].amount_paid, 0)
  assert.equal(db.bills[0].balance, 136932.8)
  assert.equal(db.bills[0].total, 136932.8)
})

test('balance follows the tax-inclusive total, not the subtotal', async () => {
  await billsModule.createRecord!(billRow('QB-2494', { subtotal: '1276.00', tax: '191.40', total: '1467.40' }), ctx)
  assert.equal(db.bills[0].balance, 1467.4)
  assert.notEqual(db.bills[0].balance, 1276)
})

test('the initial balance does not depend on the QuickBooks-derived status (allocation refresh corrects paid bills later)', async () => {
  for (const status of ['RECEIVED', 'PARTIAL', 'PAID']) {
    db.reset()
    await billsModule.createRecord!(billRow(`QB-${status}`, { subtotal: '8004.00', tax: '0', total: '8004.00', status }), ctx)
    assert.equal(db.bills[0].amount_paid, 0, status)
    assert.equal(db.bills[0].balance, 8004, status)
    assert.equal(db.bills[0].status, status, 'status is passed through unchanged')
  }
})

test('the import header still carries every previously written bill field', async () => {
  await billsModule.createRecord!(billRow('QB-1', { subtotal: '100.00', tax: '15.00', total: '115.00' }), ctx)
  const header = db.bills[0]
  for (const key of ['company_id', 'bill_no', 'date', 'status', 'subtotal', 'tax_amount', 'total', 'exchange_rate', 'base_total', 'vendor_id']) assert.ok(key in header, `missing ${key}`)
  assert.equal(header.vendor_id, 'vendor-1')
})

test('app-created and CSV/PO-created bills already set balance and are unchanged by this fix', () => {
  const read = (path: string) => readFileSync(path, 'utf8')
  assert.match(read('src/app/api/bills/route.ts'), /balance:\s*total/)
  assert.match(read('src/app/api/bills/import/route.ts'), /balance:\s*total/)
  assert.match(read('src/app/api/purchase-orders/[id]/convert/route.ts'), /balance:\s*po\.total/)
  assert.match(read('src/lib/import-export/registry/modules/transactions.module.ts'), /amount_paid:0,balance:r\.total/)
})

// ---------------------------------------------------------------- invariant
test('allocation invariant: balance = max(total - allocations, 0), amount_paid = min(allocations, total)', () => {
  assert.deepEqual(billAllocationInvariant(1467.4, 0), { amountPaid: 0, balance: 1467.4 })
  assert.deepEqual(billAllocationInvariant(8004, 8000), { amountPaid: 8000, balance: 4 })
  assert.deepEqual(billAllocationInvariant(100, 100), { amountPaid: 100, balance: 0 })
  assert.deepEqual(billAllocationInvariant(100, 130), { amountPaid: 100, balance: 0 }, 'over-application is capped at the bill total')
  assert.deepEqual(billAllocationInvariant('45800.48', '1474.66'), { amountPaid: 1474.66, balance: 44325.82 })
})

// ---------------------------------------------------------------- backfill guards
type Bill = { id: string; legacy_id: string; total: number; amount_paid: number; balance: number; deleted_at?: string | null }
const defective = (): Bill[] => REVIEWED_BILL_BACKFILL_TARGETS.map((t, i) => ({ id: `bill-${i}`, legacy_id: t.legacyId, total: t.total, amount_paid: 0, balance: 0 }))
const clean = () => ({ allocations: {}, creditAllocations: {}, payments: {}, vendorCredits: {}, nonBillLedgerRows: {} }) as Parameters<typeof planBillBalanceBackfill>[0]['dependencies']

test('reviewed target list is exactly 14 bills totalling SAR 528,874.84', () => {
  assert.equal(REVIEWED_BILL_BACKFILL_TARGETS.length, 14)
  assert.equal(REVIEWED_BILL_BACKFILL_TARGETS.reduce((s, t) => s + Math.round(t.total * 100), 0), 52887484)
  assert.equal(REVIEWED_BILL_BACKFILL_TOTAL_CENTS, 52887484)
  assert.equal(new Set(REVIEWED_BILL_BACKFILL_TARGETS.map((t) => t.legacyId)).size, 14)
})

test('backfill plan: all 14 defective bills are updated to amount_paid 0 / balance = total', () => {
  const plan = planBillBalanceBackfill({ bills: defective(), dependencies: clean() })
  assert.equal(plan.ok, true)
  assert.equal(plan.updates.length, 14)
  assert.equal(plan.alreadyCorrect.length, 0)
  assert.equal(Math.round(plan.updates.reduce((s, u) => s + u.total * 100, 0)), 52887484)
  for (const u of plan.updates) assert.deepEqual(billAllocationInvariant(u.total, 0), { amountPaid: 0, balance: u.total })
})

test('backfill plan is idempotent: already-corrected bills are a no-op, and a partial re-run only updates the rest', () => {
  const corrected = defective().map((b) => ({ ...b, balance: b.total }))
  const done = planBillBalanceBackfill({ bills: corrected, dependencies: clean() })
  assert.equal(done.ok, true); assert.equal(done.updates.length, 0); assert.equal(done.alreadyCorrect.length, 14)

  const mixed = defective(); mixed[0] = { ...mixed[0], balance: mixed[0].total }
  const partial = planBillBalanceBackfill({ bills: mixed, dependencies: clean() })
  assert.equal(partial.ok, true); assert.equal(partial.updates.length, 13); assert.equal(partial.alreadyCorrect.length, 1)
})

test('backfill aborts unless exactly the 14 reviewed bills are present', () => {
  const missing = planBillBalanceBackfill({ bills: defective().slice(1), dependencies: clean() })
  assert.equal(missing.ok, false); assert.equal(missing.updates.length, 0); assert.match(missing.aborts.join(' '), /Found 13 of 14/)
  assert.equal(planBillBalanceBackfill({ bills: [], dependencies: clean() }).ok, false)
  const shortList = planBillBalanceBackfill({ targets: REVIEWED_BILL_BACKFILL_TARGETS.slice(1), bills: defective().slice(1), dependencies: clean() })
  assert.equal(shortList.ok, false); assert.match(shortList.aborts.join(' '), /expected exactly 14/)
})

test('backfill aborts on a duplicate legacy id, a deleted bill, or a changed total', () => {
  const dup = [...defective(), { ...defective()[0], id: 'bill-dup' }]
  assert.match(planBillBalanceBackfill({ bills: dup, dependencies: clean() }).aborts.join(' '), /2 rows share the legacy id/)
  const deleted = defective(); deleted[3] = { ...deleted[3], deleted_at: '2026-09-21T00:00:00Z' }
  assert.match(planBillBalanceBackfill({ bills: deleted, dependencies: clean() }).aborts.join(' '), /is deleted/)
  const changed = defective(); changed[5] = { ...changed[5], total: changed[5].total + 0.01 }
  const plan = planBillBalanceBackfill({ bills: changed, dependencies: clean() })
  assert.equal(plan.ok, false); assert.equal(plan.updates.length, 0); assert.match(plan.aborts.join(' '), /differs from the reviewed/)
})

test('backfill aborts if a target developed any balance-affecting relationship since the review', () => {
  const bills = defective()
  const id = bills[8].id // bill 2624, the one with a payment pending
  for (const [field, label] of [['allocations', /payment allocations/], ['creditAllocations', /credit allocations/], ['payments', /linked payments/], ['vendorCredits', /vendor credits/], ['nonBillLedgerRows', /non-BILL ledger/]] as const) {
    const deps = clean(); (deps[field] as Record<string, number>)[id] = 1
    const plan = planBillBalanceBackfill({ bills, dependencies: deps })
    assert.equal(plan.ok, false, field); assert.equal(plan.updates.length, 0, `${field}: nothing may be planned when any guard fails`); assert.match(plan.aborts.join(' '), label)
  }
})

test('backfill aborts on any state other than defective (0, 0) or corrected (0, total)', () => {
  for (const state of [{ amount_paid: 100, balance: 0 }, { amount_paid: 0, balance: 50 }, { amount_paid: 8000, balance: 4 }]) {
    const bills = defective(); bills[8] = { ...bills[8], ...state }
    const plan = planBillBalanceBackfill({ bills, dependencies: clean() })
    assert.equal(plan.ok, false, JSON.stringify(state)); assert.match(plan.aborts.join(' '), /unexpected state/)
  }
})

test('the backfill script writes only with --execute, guards every write, and touches only the two balance fields', () => {
  const script = readFileSync('scripts/quickbooks/backfill-imported-bill-balances.ts', 'utf8')
  assert.match(script, /process\.argv\.includes\('--execute'\)/)
  assert.match(script, /if \(!EXECUTE\)/)
  assert.match(script, /\.update\(\{ amount_paid: 0, balance: u\.total \}\)/)
  assert.match(script, /\.eq\('amount_paid', 0\)\.eq\('balance', 0\)/, 'compare-and-set against the reviewed defective state')
  assert.doesNotMatch(script, /\.update\(\{[^}]*status/, 'must not change status')
  assert.doesNotMatch(script, /\.delete\(|ledger_entries'\)\s*\.(insert|update)/)
})
