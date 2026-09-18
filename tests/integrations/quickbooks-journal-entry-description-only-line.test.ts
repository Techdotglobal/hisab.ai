/**
 * Regression for the NETKOM Journal Entries "no migrated account" defect,
 * discovered during the final migration cleanup audit: 12 journal entries
 * (sources 4528, 3192, 3075, 2217, 1082, 1434, 1465, 3673, 3668, 343, 497,
 * 214) each end with a trailing QuickBooks `DescriptionOnly` line — a
 * free-text memo row with no `AccountRef`/`Amount` at all. `transactions
 * .module.ts`'s line-building loop already skipped `SubTotalLineDetail` but
 * had no equivalent skip for `DescriptionOnly`, so it tried to resolve an
 * account for the memo line, found none, and threw "QuickBooks Journal
 * Entries line N has no migrated account." for the WHOLE document — even
 * though every real (non-memo) line's account was correctly migrated.
 *
 * The fix skips `DescriptionOnly` lines exactly like `SubTotalLineDetail`,
 * for both the invoice-specific line loop and the shared
 * bill/expense/journal/vendorCredit/salesReceipt line loop.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-journal-entry-description-only-line.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://je-description-only-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { transactionModuleMap } = requireModule('../../src/lib/import-export/registry/modules/transactions.module') as typeof import('../../src/lib/import-export/registry/modules/transactions.module')
const journalModule = transactionModuleMap.get('journal-entries')!

const COMPANY = '88888888-8888-8888-8888-888888888888'

type Row = Record<string, unknown>
const db = {
  chart_of_accounts: [
    { id: 'acct-257', company_id: COMPANY, account_no: '257', name: 'Hoteling', canonical_type: 'Expense', is_active: true, deleted_at: null, legacy_id: '257' },
  ],
  journal_entries: [] as Row[],
  journal_lines: [] as Row[],
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

    if (table === 'chart_of_accounts' && method === 'GET') {
      let matches = db.chart_of_accounts.filter((a) => a.company_id === eq(url, 'company_id'))
      const legacyId = eq(url, 'legacy_id')
      if (legacyId) matches = matches.filter((a) => a.legacy_id === legacyId)
      return json(matches)
    }
    if (table === 'quickbooks_migration_records' && method === 'GET') {
      // resolveQuickBooksLocalId first checks this table; return none so it falls back to chart_of_accounts... but
      // in this module accounts resolve via resolveQuickBooksLocalId which queries quickbooks_migration_records directly.
      const sourceId = eq(url, 'source_id')
      const match = db.chart_of_accounts.find((a) => a.legacy_id === sourceId)
      return json(match ? { local_id: match.id, local_table: 'chart_of_accounts' } : null)
    }
    if (table === 'quickbooks_migration_local_links' && method === 'GET') return json(null)
    if (table === 'journal_entries') {
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Row
        const row = { id: randomUUID(), status: 'DRAFT', ...body }
        db.journal_entries.push(row)
        return json(row, 201)
      }
      if (method === 'GET') {
        const id = eq(url, 'id')
        return json(db.journal_entries.find((j) => j.id === id) ?? null)
      }
    }
    if (table === 'journal_lines' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Row[]
      const rows = (Array.isArray(body) ? body : [body]).map((r) => ({ id: randomUUID(), ...r }))
      db.journal_lines.push(...rows)
      return json(rows, 201)
    }
    if (method === 'GET') return json([])
    return json(null, 201)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => { db.journal_entries = []; db.journal_lines = [] })

/** Mirrors the mapped-row shape for a Journal Entry with a trailing DescriptionOnly line. */
function jeRow(sourceId: string) {
  return {
    sourceId, transactionNo: '1107', date: '2024-08-17', status: 'DRAFT', currency: 'SAR',
    total: 100, taxAmount: 0,
    lines: JSON.stringify([
      { sourceLineId: '1', detailType: 'JournalEntryLineDetail', accountSourceId: '257', debit: 100, credit: 0, description: 'Hotel charge' },
      { sourceLineId: '2', detailType: 'JournalEntryLineDetail', accountSourceId: '257', debit: 0, credit: 100, description: 'Offset' },
      { sourceLineId: '0', detailType: 'DescriptionOnly', description: 'Adjustment memo — no account, no amount' },
    ]),
    _quickbooksId: sourceId, _quickbooksEntity: 'JournalEntry', _realmId: 'realm-1',
  }
}

test('a Journal Entry with a trailing DescriptionOnly line creates successfully, skipping the memo line', async () => {
  const created = await journalModule.createRecord!(jeRow('4528'), { companyId: COMPANY, userId: 'user-1' } as never)
  const lines = db.journal_lines.filter((l) => l.journal_id === created.id)
  assert.equal(lines.length, 2, 'the DescriptionOnly line must be skipped, only the 2 real lines are inserted')
  assert.equal(lines.every((l) => l.account_id === 'acct-257'), true)
})

test('a DescriptionOnly line never triggers "has no migrated account"', async () => {
  await assert.doesNotReject(
    () => journalModule.createRecord!(jeRow('3192'), { companyId: COMPANY, userId: 'user-1' } as never),
  )
})
