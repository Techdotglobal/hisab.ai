/**
 * Regression for a NETKOM Invoice-materialization gap found during the final
 * migration cleanup audit: sources 1166 and 1168 are genuine zero-value
 * QuickBooks invoices (status PAID, total=0, subtotal=0, tax=0) — QuickBooks
 * permits a fully-paid invoice with no remaining economic content (e.g. a
 * historical record kept for continuity). `requiresLedgerFor()` already
 * carved out this zero-total exemption for `journal-entries` and `expenses`;
 * this fix extends the same exemption to `invoices`
 * (accounting-materializer.ts:48), so a $0 invoice completes with zero ledger
 * movement instead of failing "did not produce a balanced ledger entry".
 *
 * Run: npx tsx --test tests/integrations/quickbooks-invoice-zero-value-materialization.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://invoice-zero-value-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { materializeQuickBooksAccounting } = requireModule('../../src/lib/import-export/quickbooks/accounting-materializer') as typeof import('../../src/lib/import-export/quickbooks/accounting-materializer')

const COMPANY = '66666666-6666-6666-6666-666666666666'
const REALM = 'realm-invoice-zero-1'

type Row = Record<string, unknown>

const db = {
  runs: [] as Row[],
}

function runMatchesUrl(row: Row, url: URL): boolean {
  for (const key of ['company_id', 'realm_id', 'entity_type', 'source_id', 'module_key']) {
    const v = url.searchParams.get(key)
    const wanted = v?.startsWith('eq.') ? v.slice(3) : null
    if (wanted !== null && String(row[key] ?? '') !== wanted) return false
  }
  return true
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

    if (table === 'ledger_entries' && method === 'GET') return json([])
    if (table === 'stock_movements' && method === 'GET') return json([])
    if (table.startsWith('rpc/') && method === 'POST') return json(null, 200)

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
beforeEach(() => { db.runs = [] })

function sourceRow(sourceId: string, total: number) {
  return { _realmId: REALM, _quickbooksEntity: 'Invoice', _quickbooksId: sourceId, sourceId, total, currency: 'SAR' }
}

test('a genuine zero-value PAID invoice (total=0) completes without requiring a ledger entry', async () => {
  const result = await materializeQuickBooksAccounting({
    companyId: COMPANY, userId: 'user-1', moduleKey: 'invoices', localId: 'local-1166',
    sourceRow: sourceRow('1166', 0),
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.ledgerEntryCount, 0)
  const run = db.runs.find((r) => r.module_key === 'invoices' && r.source_id === '1166')
  assert.equal(run?.status, 'completed', 'must not be marked failed for having no ledger entries')
  const validation = run?.validation as Row
  assert.equal(validation.zeroMovementDocument, true)
})

test('retrying the same zero-value invoice a second time is idempotent (already completed, no double-processing)', async () => {
  const first = await materializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'invoices', localId: 'local-1168', sourceRow: sourceRow('1168', 0) })
  const second = await materializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'invoices', localId: 'local-1168', sourceRow: sourceRow('1168', 0) })
  assert.equal(first.status, 'completed')
  assert.equal(second.status, 'completed')
  assert.equal(second.ledgerEntryCount, 0)
})

test('a genuinely non-zero invoice is unaffected: requiresLedgerFor still returns true (no regression)', async () => {
  await assert.rejects(
    () => materializeQuickBooksAccounting({
      companyId: COMPANY, userId: 'user-1', moduleKey: 'invoices', localId: 'local-nonzero',
      sourceRow: sourceRow('9999', 500),
    }),
    /Invoice not found|balanced ledger entry/,
    'a non-zero invoice must still attempt real ledger posting (fails here only because no invoice/customer fixtures are wired in this minimal harness), proving the zero-total exemption never widens to cover real documents',
  )
})
