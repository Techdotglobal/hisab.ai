/**
 * Regression for `forceRematerializeQuickBooksAccounting`, built for the
 * NETKOM Journal Entry ledger remediation: `materializeQuickBooksAccounting`'s
 * normal "already completed" short-circuit must stay untouched (default
 * behavior), while a dedicated, explicit force path allows re-attempting
 * documents whose prior "completed" status predates a bug fix (e.g. the
 * Journal Entry total-miscomputation fix) — but only when zero ledger impact
 * is proven first, checked both via the cached run count and a direct
 * `ledger_entries` read, so it can never duplicate a posting.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-force-rematerialize.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://force-rematerialize-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { materializeQuickBooksAccounting, forceRematerializeQuickBooksAccounting } = requireModule('../../src/lib/import-export/quickbooks/accounting-materializer') as typeof import('../../src/lib/import-export/quickbooks/accounting-materializer')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')

const COMPANY = '99999999-9999-9999-9999-999999999999'
const REALM = 'realm-force-remat-1'

type Row = Record<string, unknown>

const db = {
  runs: [] as Row[],
  chart_of_accounts: [
    { id: 'acct-a', company_id: COMPANY, account_no: '101', name: 'Account A', canonical_type: 'Asset', is_active: true, deleted_at: null },
    { id: 'acct-b', company_id: COMPANY, account_no: '102', name: 'Account B', canonical_type: 'Asset', is_active: true, deleted_at: null },
  ] as Row[],
  journal_entries: [] as Row[],
  journal_lines: [] as Row[],
  ledger_entries: [] as Row[],
  postCallCount: 0,
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

    if (table === 'chart_of_accounts' && method === 'GET') {
      const idIn = url.searchParams.get('id')
      let matches = db.chart_of_accounts.filter((a) => a.company_id === COMPANY)
      if (idIn?.startsWith('in.(') && idIn.endsWith(')')) {
        const ids = idIn.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''))
        matches = matches.filter((a) => ids.includes(String(a.id)))
      }
      return json(matches)
    }
    if (table === 'journal_entries') {
      const id = eq(url, 'id')
      if (method === 'GET') return json(db.journal_entries.find((j) => j.id === id) ?? null)
      if (method === 'PATCH') {
        const row = db.journal_entries.find((j) => j.id === id)
        if (row) Object.assign(row, JSON.parse(String(init?.body ?? '{}')))
        return json(row ?? null)
      }
    }
    if (table === 'journal_lines' && method === 'GET') {
      const journalId = eq(url, 'journal_id')
      return json(db.journal_lines.filter((l) => l.journal_id === journalId))
    }
    if (table === 'ledger_entries') {
      if (method === 'GET') {
        const sourceId = eq(url, 'source_id')
        let matches = db.ledger_entries.filter((e) => e.source_id === sourceId)
        const sourceType = eq(url, 'source_type')
        if (sourceType) matches = matches.filter((e) => e.source_type === sourceType)
        const limit = url.searchParams.get('limit')
        if (limit) matches = matches.slice(0, Number(limit))
        return json(matches)
      }
    }
    if (table === 'rpc/post_source_document_lines' && method === 'POST') {
      db.postCallCount++
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_company_id: string; p_source_type: string; p_source_id: string; p_lines: Row[] }
      for (const line of body.p_lines) {
        db.ledger_entries.push({ id: randomUUID(), company_id: body.p_company_id, source_type: body.p_source_type, source_id: body.p_source_id, posting_sequence: db.ledger_entries.length + 1, ...line })
      }
      return json(db.ledger_entries.length, 200)
    }
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
beforeEach(() => { db.runs = []; db.journal_entries = []; db.journal_lines = []; db.ledger_entries = []; db.postCallCount = 0 })

function sourceRow(sourceId: string, total: number) {
  return { _realmId: REALM, _quickbooksEntity: 'JournalEntry', _quickbooksId: sourceId, sourceId, total, currency: 'SAR' }
}

function seedCompletedZeroLedgerRun(sourceId: string, localId: string) {
  db.runs.push({
    company_id: COMPANY, realm_id: REALM, entity_type: 'JournalEntry', source_id: sourceId, module_key: 'journal-entries',
    local_table: 'journal_entries', local_id: localId, status: 'completed', ledger_entry_count: 0, inventory_movement_count: 0,
    validation: { zeroMovementDocument: true, balancedLedger: true },
  })
}

function seedJournal(localId: string, entryNo: string, lines: Array<{ debit: number; credit: number; account_id: string }>) {
  db.journal_entries.push({ id: localId, company_id: COMPANY, entry_no: entryNo, date: '2024-08-17', description: 'Test JE', currency: 'SAR', exchange_rate: 1, status: 'DRAFT' })
  for (const l of lines) db.journal_lines.push({ id: randomUUID(), journal_id: localId, account_id: l.account_id, debit: l.debit, credit: l.credit })
}

// --- CASE A: completed + zero ledger entries -> eligible ---
test('CASE A: a completed run with zero ledger entries is eligible for force-rematerialization', async () => {
  await withCompanyContext(COMPANY, async () => {
    seedCompletedZeroLedgerRun('301', 'je-301')
    seedJournal('je-301', 'JE-301', [{ debit: 100, credit: 0, account_id: 'acct-a' }, { debit: 0, credit: 100, account_id: 'acct-b' }])
    const result = await forceRematerializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'journal-entries', localId: 'je-301', sourceRow: sourceRow('301', 100) })
    assert.equal(result.status, 'completed')
    assert.equal(result.ledgerEntryCount, 2)
    assert.equal(db.postCallCount, 1, 'postQuickBooksJournal must have actually posted')
  })
})

// --- CASE B: completed + existing valid ledger entries (cached count) -> refuse ---
test('CASE B: a completed run that already recorded ledger entries refuses force-rematerialization', async () => {
  await withCompanyContext(COMPANY, async () => {
    db.runs.push({ company_id: COMPANY, realm_id: REALM, entity_type: 'JournalEntry', source_id: '302', module_key: 'journal-entries', local_table: 'journal_entries', local_id: 'je-302', status: 'completed', ledger_entry_count: 2, inventory_movement_count: 0, validation: {} })
    seedJournal('je-302', 'JE-302', [{ debit: 50, credit: 0, account_id: 'acct-a' }, { debit: 0, credit: 50, account_id: 'acct-b' }])
    await assert.rejects(
      () => forceRematerializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'journal-entries', localId: 'je-302', sourceRow: sourceRow('302', 50) }),
      /already recorded 2 ledger entries/,
    )
    assert.equal(db.postCallCount, 0, 'must never attempt to post when the cache already shows ledger entries')
  })
})

// --- CASE C: real ledger_entries already exist even if cached count says 0 -> refuse (belt-and-suspenders) ---
test('CASE C: a real existing ledger posting is detected and refused even if the cached count is stale/zero', async () => {
  await withCompanyContext(COMPANY, async () => {
    seedCompletedZeroLedgerRun('303', 'je-303')
    seedJournal('je-303', 'JE-303', [{ debit: 75, credit: 0, account_id: 'acct-a' }, { debit: 0, credit: 75, account_id: 'acct-b' }])
    db.ledger_entries.push({ id: randomUUID(), company_id: COMPANY, source_type: 'JOURNAL', source_id: 'je-303', debit: 75, credit: 0 })
    await assert.rejects(
      () => forceRematerializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'journal-entries', localId: 'je-303', sourceRow: sourceRow('303', 75) }),
      /ledger_entries already contains a posting/,
    )
    assert.equal(db.postCallCount, 0)
  })
})

// --- CASE D: unbalanced source -> refuse (normal validateBalanced path) ---
test('CASE D: an unbalanced source document fails posting and is not marked completed with a fake balance', async () => {
  await withCompanyContext(COMPANY, async () => {
    seedCompletedZeroLedgerRun('304', 'je-304')
    seedJournal('je-304', 'JE-304', [{ debit: 100, credit: 0, account_id: 'acct-a' }, { debit: 0, credit: 115, account_id: 'acct-b' }])
    await assert.rejects(
      () => forceRematerializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'journal-entries', localId: 'je-304', sourceRow: sourceRow('304', 100) }),
    )
    const run = db.runs.find((r) => r.source_id === '304')
    assert.equal(run?.status, 'failed')
  })
})

// --- CASE G: same remediation requested twice -> second call refuses (no duplicate) ---
test('CASE G: requesting the same remediation twice never double-posts', async () => {
  await withCompanyContext(COMPANY, async () => {
    seedCompletedZeroLedgerRun('305', 'je-305')
    seedJournal('je-305', 'JE-305', [{ debit: 200, credit: 0, account_id: 'acct-a' }, { debit: 0, credit: 200, account_id: 'acct-b' }])
    const first = await forceRematerializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'journal-entries', localId: 'je-305', sourceRow: sourceRow('305', 200) })
    assert.equal(first.status, 'completed')
    assert.equal(db.postCallCount, 1)
    await assert.rejects(
      () => forceRematerializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'journal-entries', localId: 'je-305', sourceRow: sourceRow('305', 200) }),
      /already recorded/,
    )
    assert.equal(db.postCallCount, 1, 'the second attempt must not post again')
    assert.equal(db.ledger_entries.filter((e) => e.source_id === 'je-305').length, 2, 'exactly one balanced posting exists, not duplicated')
  })
})

// --- Default materializeQuickBooksAccounting behavior is completely unchanged ---
test('the normal (non-force) path still short-circuits on completed without ever attempting to post', async () => {
  await withCompanyContext(COMPANY, async () => {
    seedCompletedZeroLedgerRun('306', 'je-306')
    seedJournal('je-306', 'JE-306', [{ debit: 10, credit: 0, account_id: 'acct-a' }, { debit: 0, credit: 10, account_id: 'acct-b' }])
    const result = await materializeQuickBooksAccounting({ companyId: COMPANY, userId: 'user-1', moduleKey: 'journal-entries', localId: 'je-306', sourceRow: sourceRow('306', 10) })
    assert.equal(result.status, 'completed')
    assert.equal(result.ledgerEntryCount, 0, 'default behavior unchanged: still reports the old cached (zero) count')
    assert.equal(db.postCallCount, 0, 'default path must never post — only the explicit force function may')
  })
})
