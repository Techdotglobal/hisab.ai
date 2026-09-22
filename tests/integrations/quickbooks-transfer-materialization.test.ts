/**
 * Regression for the NETKOM Transfer defect: `materializeTransfer` returned `null` whenever both accounts were not
 * already `bank_accounts` rows — NETKOM has exactly one such row (ALBILAD), so all 31 archived QuickBooks Transfers were
 * silently skipped (the `qb-transfers` job reported `status: 'completed'`, 31 skipped, 0 imported, 0 errors).
 *
 * The fix: when both legs are tracked bank accounts, keep using `createBankTransfer` unchanged (current_balance +
 * bank_transactions feed). When at least one leg is not (an employee-advance Other-Current-Asset counterparty, or a
 * Long-Term-Liability counterparty — both real NETKOM shapes), post a plain Dr destination / Cr source journal entry
 * instead, via the new `postIdempotentTransferJournal` (never forcing a non-bank account into `bank_accounts`). Either
 * way, an unresolvable source account now fails loudly instead of returning `null`.
 *
 * Exercises the REAL `qb-transfers` extended-module `createRecord` against a minimal in-memory fake of the
 * `*.supabase.co` REST/RPC surface (harness pattern shared with quickbooks-inventory-adjustment-materialize.test.ts and
 * quickbooks-settlement-account-posting.test.ts).
 *
 * Run: npx tsx --test tests/integrations/quickbooks-transfer-materialization.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://transfer-materialize-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { quickBooksExtendedModules } = requireModule('../../src/lib/import-export/registry/modules/quickbooks-extended.module') as typeof import('../../src/lib/import-export/registry/modules/quickbooks-extended.module')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')

const COMPANY = '66666666-6666-6666-6666-666666666666'
const REALM = 'realm-transfer-1'
type Row = Record<string, unknown>

const db = {
  chart_of_accounts: [
    { id: 'coa-albilad', company_id: COMPANY, account_no: '32-3201-01', name: 'ALBILAD', is_active: true, deleted_at: null },
    { id: 'coa-sabb', company_id: COMPANY, account_no: '32-3201-02', name: 'SABB', is_active: true, deleted_at: null },
    { id: 'coa-advance', company_id: COMPANY, account_no: '32-3203-01', name: 'Employee Advance', is_active: true, deleted_at: null },
    { id: 'coa-ceo-liability', company_id: COMPANY, account_no: '21-2101-01', name: 'Mujtaba Sb (CEO)', is_active: true, deleted_at: null },
  ],
  // Only ALBILAD is a tracked bank_accounts row, mirroring NETKOM's one-row bank_accounts table.
  bank_accounts: [{ id: 'bank-albilad', company_id: COMPANY, account_id: 'coa-albilad', current_balance: 1000000, name: 'ALBILAD', currency: 'SAR', deleted_at: null }],
  bank_transfers: [] as Row[],
  bank_transactions: [] as Row[],
  journal_entries: [] as Row[],
  journal_lines: [] as Row[],
  ledger_entries: [] as Row[],
  quickbooks_migration_records: [
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '103', local_id: 'coa-albilad', local_table: 'chart_of_accounts' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '362', local_id: 'coa-sabb', local_table: 'chart_of_accounts' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '125', local_id: 'coa-advance', local_table: 'chart_of_accounts' },
    { company_id: COMPANY, realm_id: REALM, entity_type: 'Account', source_id: '405', local_id: 'coa-ceo-liability', local_table: 'chart_of_accounts' },
  ] as Row[],
  links: [] as Row[],
  warnings: [] as Row[],
  reset() { this.bank_transfers = []; this.bank_transactions = []; this.journal_entries = []; this.journal_lines = []; this.ledger_entries = []; this.links = []; this.warnings = []; this.bank_accounts[0].current_balance = 1000000 },
}

const eq = (url: URL, name: string) => { const v = url.searchParams.get(name); return v?.startsWith('eq.') ? v.slice(3) : null }
const inList = (url: URL, name: string) => { const v = url.searchParams.get(name); if (!v?.startsWith('in.(') || !v.endsWith(')')) return null; return v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')) }

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const table = url.pathname.replace('/rest/v1/', '')
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (table === 'quickbooks_migration_records') {
      if (method === 'GET') {
        const entityTypes = inList(url, 'entity_type'), sourceId = eq(url, 'source_id')
        const match = db.quickbooks_migration_records.find((r) => r.company_id === eq(url, 'company_id') && r.realm_id === eq(url, 'realm_id') && r.source_id === sourceId && (!entityTypes || entityTypes.includes(String(r.entity_type))))
        return json(match ? [match] : [])
      }
      if (method === 'POST') { const body = JSON.parse(String(init?.body ?? '{}')) as Row; db.quickbooks_migration_records.push(body); return json([{ id: randomUUID(), ...body }], 201) }
    }
    if (table === 'quickbooks_migration_local_links') { if (method === 'GET') return json([]); if (method === 'POST') { db.links.push(JSON.parse(String(init?.body ?? '{}'))); return json(null, 201) } }
    if (table === 'quickbooks_migration_warnings' && method === 'POST') { db.warnings.push(JSON.parse(String(init?.body ?? '{}'))); return json(null, 201) }

    if (table === 'chart_of_accounts' && method === 'GET') {
      let matches = db.chart_of_accounts.filter((a) => a.company_id === eq(url, 'company_id') && !a.deleted_at)
      const ids = inList(url, 'id')
      if (ids) return json(matches.filter((a) => ids.includes(a.id)))
      const id = eq(url, 'id')
      if (id) matches = matches.filter((a) => a.id === id)
      return json(matches[0] ?? null)
    }

    if (table === 'bank_accounts') {
      if (method === 'GET') {
        const ids = inList(url, 'id')
        let matches = db.bank_accounts.filter((b) => b.company_id === eq(url, 'company_id') && !b.deleted_at)
        if (ids) matches = matches.filter((b) => ids.includes(b.id))
        const accountIds = inList(url, 'account_id')
        if (accountIds) matches = matches.filter((b) => accountIds.includes(String(b.account_id)))
        return json(matches)
      }
      if (method === 'PATCH') { const body = JSON.parse(String(init?.body ?? '{}')) as Row; const id = eq(url, 'id'); const row = db.bank_accounts.find((b) => b.id === id); if (row) Object.assign(row, body); return json(row ? [row] : []) }
    }
    if (table === 'bank_transfers') {
      if (method === 'GET') { const t = eq(url, 'transfer_no'); return json(db.bank_transfers.find((b) => b.transfer_no === t) ?? null) }
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.bank_transfers.push(row); return json(row, 201) }
    }
    if (table === 'bank_transactions' && method === 'POST') { const body = JSON.parse(String(init?.body ?? '[]')); (Array.isArray(body) ? body : [body]).forEach((r: Row) => db.bank_transactions.push(r)); return json(null, 201) }

    if (table === 'journal_entries') {
      if (method === 'GET') {
        const legacyId = eq(url, 'legacy_id'), id = eq(url, 'id')
        const match = db.journal_entries.find((j) => j.company_id === eq(url, 'company_id') && (legacyId ? j.legacy_id === legacyId : id ? j.id === id : false))
        return json(match ?? null)
      }
      if (method === 'POST') { const row = { id: randomUUID(), ...(JSON.parse(String(init?.body ?? '{}')) as Row) }; db.journal_entries.push(row); return json(row, 201) }
      if (method === 'PATCH') { const body = JSON.parse(String(init?.body ?? '{}')) as Row; const id = eq(url, 'id'); const row = db.journal_entries.find((j) => j.id === id); if (row) Object.assign(row, body); return json(row ? [row] : []) }
    }
    if (table === 'journal_lines') {
      if (method === 'GET') return json(db.journal_lines.filter((l) => l.journal_id === eq(url, 'journal_id')))
      if (method === 'POST') { const body = JSON.parse(String(init?.body ?? '[]')); (Array.isArray(body) ? body : [body]).forEach((r: Row) => db.journal_lines.push({ id: randomUUID(), ...r })); return json(null, 201) }
      if (method === 'DELETE') { const jid = eq(url, 'journal_id'); db.journal_lines = db.journal_lines.filter((l) => l.journal_id !== jid); return json([]) }
    }
    if (table === 'ledger_entries' && method === 'GET') return json(db.ledger_entries.filter((l) => l.journal_entry_id === eq(url, 'journal_entry_id')))

    if (table === 'rpc/post_journal_entry' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_journal_id: string; p_company_id: string }
      const journal = db.journal_entries.find((j) => j.id === body.p_journal_id)
      if (!journal) return json({ message: 'Journal entry not found' }, 400)
      const lines = db.journal_lines.filter((l) => l.journal_id === body.p_journal_id)
      const seq = db.ledger_entries.length + 1
      for (const l of lines) db.ledger_entries.push({ id: randomUUID(), company_id: body.p_company_id, journal_entry_id: body.p_journal_id, source_type: 'JOURNAL', source_id: body.p_journal_id, account_id: l.account_id, debit: l.debit, credit: l.credit, posting_sequence: seq })
      journal.status = 'POSTED'
      return json(seq, 200)
    }
    if (table === 'rpc/post_source_document_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { p_company_id: string; p_source_type: string; p_source_id: string; p_lines: Row[] }
      const seq = db.ledger_entries.length + 1
      for (const line of body.p_lines) db.ledger_entries.push({ id: randomUUID(), company_id: body.p_company_id, source_type: body.p_source_type, source_id: body.p_source_id, posting_sequence: seq, ...line })
      return json(seq, 200)
    }
    if (table.startsWith('rpc/') && method === 'POST') return json(null, 200)

    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => db.reset())

function transferModule() {
  const m = quickBooksExtendedModules.find((mod) => mod.key === 'qb-transfers')
  if (!m) throw new Error('qb-transfers module not found')
  return m
}
const row = (id: string, raw: Row) => ({ _realmId: REALM, sourceId: id, _quickbooksId: id, _quickbooksRaw: JSON.stringify(raw) })
const ctx = { companyId: COMPANY, userId: 'user-1' } as never

test('Transfer Bank -> Bank where only one leg is a tracked bank_accounts row falls back to the journal path, not a silent skip', async () => {
  // SABB has no bank_accounts row in this fixture (mirrors NETKOM before its bank_accounts rows are seeded) — proves the
  // decision is made per-transfer on actual bank_accounts coverage, not on the QuickBooks account TYPE alone.
  const raw = { Id: '1', Amount: 214908.05, TxnDate: '2026-01-01', FromAccountRef: { value: '362' }, ToAccountRef: { value: '103' } }
  const result = await withCompanyContext(COMPANY, () => transferModule().createRecord(row('1', raw), ctx))
  assert.notEqual(result.archiveOnly, true)
  assert.equal(db.bank_transfers.length, 0, 'SABB has no bank_accounts row, so this cannot use the bank_accounts path')
  assert.equal(db.journal_entries.length, 1)
})

test('Transfer Bank -> Bank where BOTH legs are tracked bank_accounts rows posts via createBankTransfer, updates balances, and writes a matched bank_transactions pair', async () => {
  db.bank_accounts.push({ id: 'bank-sabb', company_id: COMPANY, account_id: 'coa-sabb', current_balance: 500000, name: 'SABB', currency: 'SAR', deleted_at: null })
  const raw = { Id: '2', Amount: 214908.05, TxnDate: '2026-01-01', FromAccountRef: { value: '362' }, ToAccountRef: { value: '103' } }
  const result = await withCompanyContext(COMPANY, () => transferModule().createRecord(row('2', raw), ctx))
  assert.notEqual(result.archiveOnly, true)
  assert.equal(db.bank_transfers.length, 1)
  assert.equal(db.bank_transactions.length, 2, 'a matched Dr/Cr bank_transactions pair')
  const sabb = db.bank_accounts.find((b) => b.id === 'bank-sabb')!, albilad = db.bank_accounts.find((b) => b.id === 'bank-albilad')!
  assert.equal(Number(sabb.current_balance), 500000 - 214908.05)
  assert.equal(Number(albilad.current_balance), 1000000 + 214908.05)
  const ledger = db.ledger_entries.filter((l) => l.source_id === db.bank_transfers[0].id)
  assert.equal(ledger.length, 2)
  assert.equal(ledger.reduce((s, l) => s + Number(l.debit ?? 0), 0), ledger.reduce((s, l) => s + Number(l.credit ?? 0), 0))
})

test('Transfer Bank -> Other Current Asset (employee advance, not a tracked bank account) posts a balanced Dr/Cr journal entry, no P&L account touched', async () => {
  const raw = { Id: '3', Amount: 1200, TxnDate: '2026-01-01', FromAccountRef: { value: '103' }, ToAccountRef: { value: '125' } }
  const result = await withCompanyContext(COMPANY, () => transferModule().createRecord(row('3', raw), ctx))
  assert.notEqual(result.archiveOnly, true, 'must materialize, not silently skip')
  assert.equal(db.bank_transfers.length, 0, 'must never force the employee-advance account into bank_accounts')
  assert.equal(db.journal_entries.length, 1)
  assert.equal(db.journal_entries[0].status, 'POSTED')
  const lines = db.journal_lines.filter((l) => l.journal_id === db.journal_entries[0].id)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((l) => [l.account_id, Number(l.debit), Number(l.credit)]).sort(), [['coa-advance', 1200, 0], ['coa-albilad', 0, 1200]].sort())
})

test('Transfer Bank -> Long-Term Liability (a CEO liability counterparty, not a bank account) also posts a balanced Dr/Cr journal entry', async () => {
  const raw = { Id: '4', Amount: 18743, TxnDate: '2026-01-01', FromAccountRef: { value: '103' }, ToAccountRef: { value: '405' } }
  const result = await withCompanyContext(COMPANY, () => transferModule().createRecord(row('4', raw), ctx))
  assert.notEqual(result.archiveOnly, true)
  assert.equal(db.bank_transfers.length, 0)
  const lines = db.journal_lines.filter((l) => l.journal_id === db.journal_entries[0].id)
  assert.deepEqual(lines.map((l) => [l.account_id, Number(l.debit), Number(l.credit)]).sort(), [['coa-ceo-liability', 18743, 0], ['coa-albilad', 0, 18743]].sort())
})

test('re-materializing the same non-bank Transfer a second time is idempotent (no second journal, no double posting)', async () => {
  const raw = { Id: '3', Amount: 1200, TxnDate: '2026-01-01', FromAccountRef: { value: '103' }, ToAccountRef: { value: '125' } }
  await withCompanyContext(COMPANY, () => transferModule().createRecord(row('3', raw), ctx))
  await withCompanyContext(COMPANY, () => transferModule().createRecord(row('3', raw), ctx))
  assert.equal(db.journal_entries.length, 1, 'must not create a second journal entry for the same source Transfer')
  const ledgerForJournal = db.ledger_entries.filter((l) => l.journal_entry_id === db.journal_entries[0].id)
  assert.equal(ledgerForJournal.length, 2, 'must not double-post')
})

test('a Transfer changing amount after posting fails loudly instead of silently drifting or double-posting', async () => {
  const raw = { Id: '3', Amount: 1200, TxnDate: '2026-01-01', FromAccountRef: { value: '103' }, ToAccountRef: { value: '125' } }
  await withCompanyContext(COMPANY, () => transferModule().createRecord(row('3', raw), ctx))
  const changed = { ...raw, Amount: 9999 }
  await assert.rejects(
    () => withCompanyContext(COMPANY, () => transferModule().createRecord(row('3', changed), ctx)),
    /changed after it was posted/,
  )
})

test('a Transfer whose source account cannot be resolved fails closed (throws) rather than silently returning null / archive-only', async () => {
  const raw = { Id: '5', Amount: 100, TxnDate: '2026-01-01', FromAccountRef: { value: '999' }, ToAccountRef: { value: '103' } }
  await assert.rejects(
    () => withCompanyContext(COMPANY, () => transferModule().createRecord(row('5', raw), ctx)),
    /QuickBooks account 999 must be migrated/,
  )
})

test('a Transfer with no positive amount fails closed', async () => {
  const raw = { Id: '6', Amount: 0, TxnDate: '2026-01-01', FromAccountRef: { value: '103' }, ToAccountRef: { value: '362' } }
  await assert.rejects(() => withCompanyContext(COMPANY, () => transferModule().createRecord(row('6', raw), ctx)), /no positive amount/)
})
