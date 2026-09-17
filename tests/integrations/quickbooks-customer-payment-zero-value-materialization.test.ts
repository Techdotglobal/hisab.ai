/**
 * Regression for a NETKOM customer-payment materialization gap found during
 * the final migration cleanup audit: source 129 is a genuine zero-value
 * QuickBooks customer payment (amount=0, e.g. a historical receipt record
 * kept for continuity). Without an exemption, `postPaymentToLedger` still
 * ran and `validateBalanced()` threw "Entry must have non-zero amounts"
 * (code ZERO_AMOUNT). `requiresLedgerFor()` already exempted zero-total
 * journal-entries, expenses, and invoices; this extends the same exemption
 * to `customer-payments` (accounting-materializer.ts:49).
 *
 * Run: npx tsx --test tests/integrations/quickbooks-customer-payment-zero-value-materialization.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://customer-payment-zero-value-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { materializeQuickBooksAccounting } = requireModule('../../src/lib/import-export/quickbooks/accounting-materializer') as typeof import('../../src/lib/import-export/quickbooks/accounting-materializer')

const COMPANY = '77777777-7777-7777-7777-777777777777'
const REALM = 'realm-payment-zero-1'

type Row = Record<string, unknown>

const db = {
  runs: [] as Row[],
  payments: [] as Row[],
  allocations: [] as Row[],
}

function runMatchesUrl(row: Row, url: URL): boolean {
  for (const key of ['company_id', 'realm_id', 'entity_type', 'source_id', 'module_key']) {
    const v = url.searchParams.get(key)
    const wanted = v?.startsWith('eq.') ? v.slice(3) : null
    if (wanted !== null && String(row[key] ?? '') !== wanted) return false
  }
  return true
}
function eq(url: URL, name: string) { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (table === 'ledger_entries' && method === 'GET') return json([])
    if (table === 'stock_movements' && method === 'GET') return json([])
    if (table.startsWith('rpc/') && method === 'POST') return json(null, 200)
    if (table === 'payments' && method === 'GET') {
      const id = eq(url, 'id')
      return json(db.payments.find((p) => p.id === id) ?? null)
    }
    if (table === 'payment_allocations' && method === 'GET') {
      const paymentId = eq(url, 'payment_id')
      return json(db.allocations.filter((a) => a.payment_id === paymentId))
    }

    if (table === 'quickbooks_materialization_runs') {
      if (method === 'GET') return json(db.runs.find((r) => runMatchesUrl(r, url)) ?? null)
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Row
        const existing = db.runs.find((r) => ['company_id', 'realm_id', 'entity_type', 'source_id', 'module_key'].every((k) => r[k] === body[k]))
        if (existing) Object.assign(existing, body); else db.runs.push({ ...body })
        return json(existing ?? body, 201)
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Row
        const matches = db.runs.filter((r) => runMatchesUrl(r, url))
        for (const row of matches) Object.assign(row, body)
        return json(matches)
      }
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => { db.runs = []; db.payments = []; db.allocations = [] })

function sourceRow(sourceId: string, amount: number) {
  return { _realmId: REALM, _quickbooksEntity: 'Payment', _quickbooksId: sourceId, sourceId, amount, currency: 'SAR' }
}

test('a genuine zero-value customer payment (amount=0) completes without requiring a ledger entry', async () => {
  db.payments.push({ id: 'local-129', amount: 0 })
  const result = await materializeQuickBooksAccounting({
    companyId: COMPANY, userId: 'user-1', moduleKey: 'customer-payments', localId: 'local-129',
    sourceRow: sourceRow('129', 0),
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.ledgerEntryCount, 0)
  const run = db.runs.find((r) => r.module_key === 'customer-payments' && r.source_id === '129')
  assert.equal(run?.status, 'completed', 'must not be marked failed for having no ledger entries')
  const validation = run?.validation as Row
  assert.equal(validation.zeroMovementDocument, true)
})

test('retrying the same zero-value customer payment a second time is idempotent', async () => {
  db.payments.push({ id: 'local-129', amount: 0 })
  const first = await materializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'customer-payments', localId: 'local-129', sourceRow: sourceRow('129', 0) })
  const second = await materializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'customer-payments', localId: 'local-129', sourceRow: sourceRow('129', 0) })
  assert.equal(first.status, 'completed')
  assert.equal(second.status, 'completed')
  assert.equal(second.ledgerEntryCount, 0)
})
