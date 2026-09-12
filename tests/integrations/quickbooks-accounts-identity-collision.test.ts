/**
 * Regression for the NETKOM Accounts identity-collision bug.
 *
 * Root cause: `accounts.module.ts` matched/duplicated QuickBooks accounts purely
 * by `accountNo`. QuickBooks permits an account number to be reused after the
 * original account is deleted (e.g. NETKOM's real "Accounts Receivable (A/R)",
 * QBO Id 335, and a long-deleted "ACCOUNTS RECEIVABLE (deleted)", QBO Id 104,
 * both compute `accountNo = "32-3202"`). The importer silently merged both
 * QuickBooks identities into a single native `chart_of_accounts` row, and
 * whichever was processed last won — in production this was the deleted
 * account, corrupting the real AR account and causing all 556 NETKOM invoice
 * postings to fail (no active Accounts Receivable account could be found).
 *
 * The fix threads the QuickBooks `Id` (exposed on every normalized row as
 * `sourceId`) through as the account's `legacy_id`, and duplicate matching
 * prefers `legacy_id` over `accountNo` whenever a `sourceId` is present —
 * mirroring the identity model already used by `quickbooks-extended.module.ts`
 * (`duplicateKeys: ['sourceId']`) and `transactions.module.ts`'s legacy path.
 * `accountNo` matching remains the fallback only for non-QuickBooks (plain
 * CSV) imports, which never carry a `sourceId`.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-accounts-identity-collision.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://accounts-identity-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { accountsModule } = requireModule('../../src/lib/import-export/registry/modules/accounts.module') as typeof import('../../src/lib/import-export/registry/modules/accounts.module')
const { withCompanyContext } = requireModule('../../src/lib/tenant') as typeof import('../../src/lib/tenant')

const COMPANY = '11111111-1111-1111-1111-111111111111'

/** In-memory `chart_of_accounts` faking the Postgres unique(company_id, account_no) table. */
let rows: Record<string, unknown>[] = []

function eq(url: URL, name: string): string | null {
  const v = url.searchParams.get(name)
  return v?.startsWith('eq.') ? v.slice(3) : null
}
function inList(url: URL, name: string): string[] | null {
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
    const idEq = eq(url, 'id')
    const legacyIdEq = eq(url, 'legacy_id')
    const legacyIdIn = inList(url, 'legacy_id')
    const accountNoEq = eq(url, 'account_no')
    const accountNoIn = inList(url, 'account_no')

    if (method === 'GET') {
      let matches = rows.filter((r) => r.company_id === companyId)
      if (idEq) matches = matches.filter((r) => r.id === idEq)
      if (legacyIdEq) matches = matches.filter((r) => r.legacy_id === legacyIdEq)
      if (legacyIdIn) matches = matches.filter((r) => legacyIdIn.includes(String(r.legacy_id)))
      if (accountNoEq) matches = matches.filter((r) => r.account_no === accountNoEq)
      if (accountNoIn) matches = matches.filter((r) => accountNoIn.includes(String(r.account_no)))
      return json(matches)
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const now = new Date().toISOString()
      const row = { id: randomUUID(), created_at: now, updated_at: now, deleted_at: null, ...body }
      rows.push(row)
      return json(row, 201)
    }
    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      let matches = rows.filter((r) => r.company_id === companyId)
      if (idEq) matches = matches.filter((r) => r.id === idEq)
      for (const r of matches) Object.assign(r, body, { updated_at: new Date().toISOString() })
      return json(matches[0] ?? null)
    }
    return json([])
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => { rows = [] })

function qbRow(sourceId: string, accountNo: string, name: string, isActive: boolean, extra: Record<string, unknown> = {}) {
  return {
    sourceId,
    accountNo,
    name,
    fullName: name,
    accountType: 'Other Current Asset',
    subType: 'OtherCurrentAssets',
    isActive: String(isActive),
    ...extra,
  }
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return withCompanyContext(COMPANY, fn)
}

test('two QuickBooks accounts with the same accountNo but different sourceIds produce two native rows', async () => {
  await run(async () => {
    const active = qbRow('335', '32-3202', 'Accounts Receivable (A/R)', true)
    const deleted = qbRow('104', '32-3202', 'ACCOUNTS RECEIVABLE (deleted)', false)

    const activeDup = await accountsModule.findDuplicate!(active, {} as never)
    assert.equal(activeDup, null, 'no existing row yet')
    const created1 = await accountsModule.createRecord!(active, {} as never)

    const deletedDup = await accountsModule.findDuplicate!(deleted, {} as never)
    assert.equal(deletedDup, null, 'must NOT match the active account merely by shared accountNo')
    const created2 = await accountsModule.createRecord!(deleted, {} as never)

    assert.notEqual(created1.id, created2.id, 'two distinct native rows must exist')
    assert.equal(rows.length, 2)
  })
})

test('active-then-deleted processing order does not corrupt the active row', async () => {
  await run(async () => {
    await accountsModule.createRecord!(qbRow('335', '32-3202', 'Accounts Receivable (A/R)', true), {} as never)
    await accountsModule.createRecord!(qbRow('104', '32-3202', 'ACCOUNTS RECEIVABLE (deleted)', false), {} as never)

    const ar = rows.find((r) => r.legacy_id === '335')!
    assert.equal(ar.name, 'Accounts Receivable (A/R)')
    assert.equal(ar.is_active, true)
  })
})

test('deleted-then-active processing order produces the same final identity mapping', async () => {
  await run(async () => {
    await accountsModule.createRecord!(qbRow('104', '32-3202', 'ACCOUNTS RECEIVABLE (deleted)', false), {} as never)
    await accountsModule.createRecord!(qbRow('335', '32-3202', 'Accounts Receivable (A/R)', true), {} as never)

    const ar = rows.find((r) => r.legacy_id === '335')!
    const stale = rows.find((r) => r.legacy_id === '104')!
    assert.equal(ar.name, 'Accounts Receivable (A/R)')
    assert.equal(ar.is_active, true)
    assert.equal(stale.is_active, false)
    assert.notEqual(ar.id, stale.id, 'order must not merge the two identities regardless of sequence')
  })
})

test('duplicateStrategy=update rerun against the same snapshot is idempotent', async () => {
  await run(async () => {
    const active = qbRow('335', '32-3202', 'Accounts Receivable (A/R)', true)
    const created = await accountsModule.createRecord!(active, {} as never)
    assert.equal(rows.length, 1)

    // Second pass over the same source row: findDuplicate must now match by
    // legacy_id and updateRecord must not create a second row.
    const dup = await accountsModule.findDuplicate!(active, {} as never)
    assert.ok(dup, 'must find the existing row on rerun')
    assert.equal(dup!.id, created.id)
    assert.deepEqual(dup!.matchedOn, ['sourceId'])
    await accountsModule.updateRecord!(dup!.id, active, {} as never)
    assert.equal(rows.length, 1, 'no duplicate row created on idempotent rerun')
  })
})

test('legacy_id match takes priority over accountNo match', async () => {
  await run(async () => {
    // Simulate a row that has already been reconciled (legacy_id set) but whose
    // accountNo happens to also match a different, unrelated import row's accountNo.
    const now = new Date().toISOString()
    rows.push({ id: randomUUID(), company_id: COMPANY, account_no: '32-3202', legacy_id: '335', name: 'Accounts Receivable (A/R)', is_active: true, deleted_at: null, created_at: now, updated_at: now })

    const dup = await accountsModule.findDuplicate!(qbRow('335', '32-3202', 'Accounts Receivable (A/R)', true), {} as never)
    assert.ok(dup)
    assert.deepEqual(dup!.matchedOn, ['sourceId'])
  })
})

test('literal AR case: QBO 335 vs QBO 104 never collapse into one row', async () => {
  await run(async () => {
    await accountsModule.createRecord!(qbRow('335', '32-3202', 'Accounts Receivable (A/R)', true, { accountType: 'Accounts Receivable', subType: 'AccountsReceivable' }), {} as never)
    await accountsModule.createRecord!(qbRow('104', '32-3202', 'ACCOUNTS RECEIVABLE (deleted)', false), {} as never)
    assert.equal(rows.length, 2)
    const ar = rows.find((r) => r.legacy_id === '335')!
    assert.equal(ar.account_type, 'Accounts Receivable')
    assert.equal(ar.is_active, true)
  })
})

test('literal Input VAT case: QBO 87 vs QBO 323 never collapse into one row', async () => {
  await run(async () => {
    await accountsModule.createRecord!(qbRow('87', '32-3203-320305-01', 'INPUT VAT ON GOODS AND SERVICES', true), {} as never)
    await accountsModule.createRecord!(qbRow('323', '32-3203-320305-01', 'GOODS (deleted)', false), {} as never)
    assert.equal(rows.length, 2)
    const vat = rows.find((r) => r.legacy_id === '87')!
    assert.equal(vat.name, 'INPUT VAT ON GOODS AND SERVICES')
    assert.equal(vat.is_active, true)
  })
})

test('invariant: one QBO sourceId maps to exactly one native account across repeated imports', async () => {
  await run(async () => {
    const sourceIds = ['335', '104', '87', '323', '370', '138']
    for (const id of sourceIds) {
      await accountsModule.createRecord!(qbRow(id, `acct-${id}`, `Account ${id}`, true), {} as never)
    }
    // Re-run the same batch — every one must resolve to its existing row, not create a new one.
    for (const id of sourceIds) {
      const dup = await accountsModule.findDuplicate!(qbRow(id, `acct-${id}`, `Account ${id}`, true), {} as never)
      assert.ok(dup, `sourceId ${id} must already exist`)
    }
    assert.equal(rows.length, sourceIds.length)
    const legacyIds = rows.map((r) => r.legacy_id)
    assert.equal(new Set(legacyIds).size, legacyIds.length, 'no legacy_id is shared by more than one row')
  })
})

test('parent resolution: a missing-AcctNum parent (account 175 pattern) is preserved as-is', async () => {
  await run(async () => {
    // The adapter's own accountNoById map already renders a missing-AcctNum
    // parent as `QB-<Id>` before accounts.module.ts ever sees the row — this
    // test only confirms parseAccountImportRow passes parentNo through untouched.
    const created = await accountsModule.createRecord!(qbRow('199', '31-3101-310105', 'TECHNICAL/IT EQUIPMENT (deleted)', false, { parentNo: 'QB-175' }), {} as never)
    const stored = rows.find((r) => r.id === created.id)!
    assert.equal(stored.parent_no, 'QB-175')
  })
})

test('non-QuickBooks CSV import: accountNo remains the duplicate key when no sourceId is present', async () => {
  await run(async () => {
    const csvRow = { accountNo: 'CSV-100', name: 'Manual Bank Account', accountType: 'Bank', subType: 'Bank', isActive: 'true' }
    const created = await accountsModule.createRecord!(csvRow, {} as never)
    assert.equal(rows.find((r) => r.id === created.id)!.legacy_id, null, 'CSV rows never get a legacy_id')

    const dup = await accountsModule.findDuplicate!({ ...csvRow, name: 'Manual Bank Account Renamed' }, {} as never)
    assert.ok(dup, 'a second CSV row with the same accountNo must still match by accountNo')
    assert.deepEqual(dup!.matchedOn, ['accountNo'])
  })
})

test('CSV update of an already-QuickBooks-linked account does not null out its legacy_id', async () => {
  await run(async () => {
    const created = await accountsModule.createRecord!(qbRow('335', '32-3202', 'Accounts Receivable (A/R)', true), {} as never)
    // A later plain-CSV re-import of the same accountNo (no sourceId) touches only display fields.
    await accountsModule.updateRecord!(created.id, { accountNo: '32-3202', name: 'Accounts Receivable (A/R)', accountType: 'Accounts Receivable', subType: 'AccountsReceivable', isActive: 'true' }, {} as never)
    const stored = rows.find((r) => r.id === created.id)!
    assert.equal(stored.legacy_id, '335', 'legacy_id must survive a non-QuickBooks update call')
  })
})
