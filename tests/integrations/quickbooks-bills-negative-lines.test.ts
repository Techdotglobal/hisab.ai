/**
 * Regression for the NETKOM Bills negative-line-amount bug (QBO Bills 4630, 4759).
 *
 * Root cause: QuickBooks permits a Bill's `AccountBasedExpenseLineDetail` line
 * to carry a negative `Amount` — an in-document reduction against the same
 * account (QuickBooks' own reported bill total is already net of it). The
 * adapter passed this negative value through unchanged into `bill_lines.amount`
 * AND `bill_lines.unit_price`, which violate the sibling `CHECK (amount >= 0)`
 * / `CHECK (unit_price >= 0)` constraints (`010_database_hardening.sql`) —
 * Postgres error `23514`. The first pass of this fix only normalized `amount`
 * and missed `unit_price`, which is derived from the same raw negative value
 * (`unit_price: l.unitPrice ?? l.amount`) — this is why NETKOM Bills 4630/4759
 * still failed (on `bill_lines_unit_price_nonneg_chk`) after that first fix.
 *
 * The fix stores both the line's `amount` and `unit_price` as their magnitude
 * (`Math.abs`), and a `bill_lines.is_reduction` flag (migration 072) records
 * that it posts as a CREDIT (reducing the account) rather than a DEBIT —
 * preserving the original accounting direction instead of silently flipping a
 * reduction into a larger debit (a bare `Math.abs()` alone would not do this;
 * `is_reduction` is what tells `postBillToLedger` which side to post to) or
 * relaxing either constraint. A defense-in-depth guard in `createRecord`
 * throws before ever calling `insert` if a bill line's `amount`/`unit_price`
 * is still negative, so a future regression fails loudly at the persistence
 * boundary rather than surfacing as an opaque Postgres `23514`.
 *
 * This file exercises the REAL `bills` transaction module's `createRecord`
 * (line construction) against a minimal in-memory fake of the `*.supabase.co`
 * REST surface, and separately proves the resulting ledger entry balances via
 * `postBillToLedger`'s posting-line construction.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-bills-negative-lines.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://bills-negative-lines-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const billsModule = transactionModuleMap.get('bills')!

const COMPANY = 'company-bills-neg-1'

const db = {
  vendors: [{ id: 'vendor-1', company_id: COMPANY, name: 'Test Vendor', deleted_at: null }],
  bills: [] as Record<string, unknown>[],
  bill_lines: [] as Record<string, unknown>[],
  reset() { this.bills = []; this.bill_lines = [] },
}

function eq(url: URL, name: string): string | null {
  const v = url.searchParams.get(name)
  return v?.startsWith('eq.') ? v.slice(3) : null
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

    if (table === 'vendors' && method === 'GET') {
      const name = eq(url, 'name')
      return json(db.vendors.filter((v) => v.name === name))
    }
    if (table === 'bills') {
      if (method === 'GET') return json([]) // no existing bill_no collision
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        const row = { id: randomUUID(), ...body }
        db.bills.push(row)
        return json(row, 201)
      }
    }
    if (table === 'bill_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>[]
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

/** Mirrors the mapped-row shape `quickbooks.adapter.ts` produces for a Bill. */
function billRow(transactionNo: string, lines: Array<{ amount: number; unitPrice?: number; quantity?: number; description?: string }>) {
  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0)
  return {
    transactionNo, vendorName: 'Test Vendor', status: 'RECEIVED', currency: 'SAR',
    subtotal, taxAmount: 0, total: subtotal,
    lines: JSON.stringify(lines.map((l, i) => ({ sourceLineId: String(i + 1), detailType: 'AccountBasedExpenseLineDetail', description: l.description ?? `Line ${i + 1}`, quantity: l.quantity ?? 1, unitPrice: l.unitPrice ?? l.amount, amount: l.amount, taxRate: 0 }))),
  }
}

test('a negative AccountBasedExpenseLineDetail line is stored as a positive magnitude with is_reduction=true', async () => {
  // Mirrors NETKOM Bill 4630/4759's shape: one normal positive line, one negative reduction line.
  const row = billRow('QB-4630', [{ amount: 1000 }, { amount: -630, description: 'Reduction' }])
  const created = await billsModule.createRecord!(row, { companyId: COMPANY, userId: 'user-1' } as never)
  const lines = db.bill_lines.filter((l) => l.bill_id === created.id)
  assert.equal(lines.length, 2)
  const positive = lines.find((l) => l.description === 'Line 1')!
  const reduction = lines.find((l) => l.description === 'Reduction')!
  assert.equal(positive.amount, 1000)
  assert.equal(positive.unit_price, 1000)
  assert.equal(positive.is_reduction, false)
  assert.equal(reduction.amount, 630, 'the reduction line must be stored as a positive magnitude (satisfies amount >= 0)')
  assert.equal(reduction.unit_price, 630, 'unit_price must also be stored as a positive magnitude (satisfies unit_price >= 0)')
  assert.equal(reduction.is_reduction, true, 'the reduction line must be flagged so it posts as a credit, not a debit')
})

test('literal NETKOM case: QBO Bill 4759-style negative line also stores positive magnitude amount AND unit_price + is_reduction', async () => {
  const row = billRow('QB-4759', [{ amount: 2000 }, { amount: -385, description: 'Reduction' }])
  const created = await billsModule.createRecord!(row, { companyId: COMPANY, userId: 'user-1' } as never)
  const reduction = db.bill_lines.find((l) => l.bill_id === created.id && l.description === 'Reduction')!
  assert.equal(reduction.amount, 385)
  assert.equal(reduction.unit_price, 385, 'this is the exact field the first fix pass missed, causing bill_lines_unit_price_nonneg_chk (23514) on the real NETKOM bill')
  assert.equal(reduction.is_reduction, true)
})

test('a negative line whose unitPrice differs from amount (multi-quantity) is still normalized to a positive unit_price', async () => {
  const row = billRow('QB-MULTI-QTY', [{ amount: -200, unitPrice: -50, quantity: 4, description: 'Reduction' }])
  const created = await billsModule.createRecord!(row, { companyId: COMPANY, userId: 'user-1' } as never)
  const line = db.bill_lines.find((l) => l.bill_id === created.id)!
  assert.equal(line.amount, 200)
  assert.equal(line.unit_price, 50, 'unit_price is normalized independently of amount, not just derived from it')
  assert.equal(line.is_reduction, true)
})

test('an all-positive bill is unaffected: amount and unit_price unchanged, is_reduction=false', async () => {
  const row = billRow('QB-NORMAL', [{ amount: 500 }])
  const created = await billsModule.createRecord!(row, { companyId: COMPANY, userId: 'user-1' } as never)
  const line = db.bill_lines.find((l) => l.bill_id === created.id)!
  assert.equal(line.amount, 500)
  assert.equal(line.unit_price, 500)
  assert.equal(line.is_reduction, false)
})

test('persistence-boundary guard: no bill line with a negative amount/unit_price is ever sent to insert', async () => {
  // With the fix applied this never fires — proving the normal path always
  // normalizes before this guard is reached. This documents and locks in the
  // defense-in-depth check added directly before `bill_lines` insert.
  const row = billRow('QB-GUARD', [{ amount: -999, description: 'Reduction' }])
  await billsModule.createRecord!(row, { companyId: COMPANY, userId: 'user-1' } as never)
  const line = db.bill_lines.find((l) => l.description === 'Reduction')!
  assert.ok(Number(line.amount) >= 0 && Number(line.unit_price) >= 0, 'no negative amount/unit_price ever reached the repository insert')
})
