/**
 * Regression for the NETKOM Bills VAT-account-resolution bug.
 *
 * Root cause: `buildTaxJournalLines` searched for a system account using a
 * single literal name (`nameContains: 'VAT Receivable'`). NETKOM's real input
 * VAT account is named "INPUT VAT ON GOODS AND SERVICES" — a legitimate,
 * QuickBooks-migrated naming convention that never matches that literal
 * string — so the tax debit line was silently omitted, and every bill with
 * tax failed much later with an opaque "Debits must equal credits" error.
 *
 * QuickBooks Online's Automated Sales Tax model never exposes the underlying
 * GL accounts through its API (verified against NETKOM's real TaxAgency
 * payload — no account ref of any kind), so there is no QuickBooks identity
 * that can name "the VAT account" for a migrated company; which native
 * account plays that role is inherently a destination naming convention.
 * The fix tries a priority-ordered list of real-world naming conventions
 * (`findSystemAccountByNameCandidates`) instead of one rigid literal, and
 * throws an explicit, diagnosable error when no candidate resolves — instead
 * of silently producing an unbalanced journal entry.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-bills-vat-resolution.test.ts
 */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://bills-vat-resolution-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { buildTaxJournalLines } = requireModule('../../src/lib/tax/journal-posting') as typeof import('../../src/lib/tax/journal-posting')

const COMPANY = 'company-vat-1'

let accounts: Array<Record<string, unknown>> = []

function account(name: string, canonicalType: string, extra: Record<string, unknown> = {}) {
  return { id: `acct-${name}`, company_id: COMPANY, name, canonical_type: canonicalType, is_active: true, deleted_at: null, account_no: extra.account_no ?? 'X', ...extra }
}

let restoreFetch: (() => void) | null = null
before(() => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.hostname.endsWith('.supabase.co')) return realFetch(input, init)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const table = url.pathname.replace('/rest/v1/', '')
    if (table !== 'chart_of_accounts') return json([])

    const companyId = url.searchParams.get('company_id')?.replace('eq.', '')
    const isActive = url.searchParams.get('is_active')?.replace('eq.', '')
    const canonicalType = url.searchParams.get('canonical_type')?.replace('eq.', '')
    const nameIlike = url.searchParams.get('name')
    const nameFragment = nameIlike?.startsWith('ilike.%') ? nameIlike.slice(7, -1) : null

    let matches = accounts.filter((a) => a.company_id === companyId)
    if (isActive) matches = matches.filter((a) => String(a.is_active) === isActive)
    if (canonicalType) matches = matches.filter((a) => a.canonical_type === canonicalType)
    if (nameFragment) matches = matches.filter((a) => String(a.name).toLowerCase().includes(nameFragment.toLowerCase()))
    return json(matches)
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = realFetch }
})
after(() => restoreFetch?.())
beforeEach(() => { accounts = [] })

test('NETKOM-style "INPUT VAT ON GOODS AND SERVICES" resolves as the bill-side VAT receivable account', async () => {
  accounts.push(account('INPUT VAT ON GOODS AND SERVICES', 'Asset'))
  const lines = await buildTaxJournalLines({
    companyId: COMPANY, documentNo: 'BILL-1', documentType: 'BILL', isSales: false,
    components: [{ name: 'VAT', rate: 15, taxMode: 'EXCLUSIVE', taxableAmount: 1000, taxAmount: 150, isReverseCharge: false, isWithholding: false }],
  })
  assert.equal(lines.length, 1)
  assert.equal(lines[0].accountId, 'acct-INPUT VAT ON GOODS AND SERVICES')
  assert.equal(lines[0].debit, 150)
})

test('hisab.ai default "VAT Receivable" naming still resolves (backward compatible)', async () => {
  accounts.push(account('VAT Receivable', 'Asset'))
  const lines = await buildTaxJournalLines({
    companyId: COMPANY, documentNo: 'BILL-2', documentType: 'BILL', isSales: false,
    components: [{ name: 'VAT', rate: 15, taxMode: 'EXCLUSIVE', taxableAmount: 1000, taxAmount: 150, isReverseCharge: false, isWithholding: false }],
  })
  assert.equal(lines[0].accountId, 'acct-VAT Receivable')
})

test('no resolvable VAT receivable account throws an explicit, diagnosable error instead of silently omitting the line', async () => {
  // No matching account at all — the historical bug would have returned [] here.
  await assert.rejects(
    () => buildTaxJournalLines({
      companyId: COMPANY, documentNo: 'BILL-3', documentType: 'BILL', isSales: false,
      components: [{ name: 'VAT', rate: 15, taxMode: 'EXCLUSIVE', taxableAmount: 1000, taxAmount: 150, isReverseCharge: false, isWithholding: false }],
    }),
    (err: Error) => {
      assert.equal(err.name, 'MissingTaxAccountError')
      assert.match(err.message, /VAT Receivable/)
      assert.match(err.message, /BILL-3/)
      return true
    },
  )
})

test('sales-side (invoice) VAT payable resolves via the "Output VAT" naming convention', async () => {
  accounts.push(account('OUTPUT VAT PAYABLE ON SERVICES (15%)', 'Liability'))
  const lines = await buildTaxJournalLines({
    companyId: COMPANY, documentNo: 'INV-1', documentType: 'INVOICE', isSales: true,
    components: [{ name: 'VAT', rate: 15, taxMode: 'EXCLUSIVE', taxableAmount: 1000, taxAmount: 150, isReverseCharge: false, isWithholding: false }],
  })
  assert.equal(lines[0].accountId, 'acct-OUTPUT VAT PAYABLE ON SERVICES (15%)')
  assert.equal(lines[0].credit, 150)
})

test('no resolvable VAT payable account throws for the sales side', async () => {
  await assert.rejects(
    () => buildTaxJournalLines({
      companyId: COMPANY, documentNo: 'INV-2', documentType: 'INVOICE', isSales: true,
      components: [{ name: 'VAT', rate: 15, taxMode: 'EXCLUSIVE', taxableAmount: 1000, taxAmount: 150, isReverseCharge: false, isWithholding: false }],
    }),
    (err: Error) => { assert.equal(err.name, 'MissingTaxAccountError'); assert.match(err.message, /VAT Payable/); return true },
  )
})

test('reverse-charge requires both accounts and throws naming whichever is missing', async () => {
  accounts.push(account('INPUT VAT ON GOODS AND SERVICES', 'Asset'))
  // vatPayable deliberately missing.
  await assert.rejects(
    () => buildTaxJournalLines({
      companyId: COMPANY, documentNo: 'BILL-RC-1', documentType: 'BILL', isSales: false,
      components: [{ name: 'RC VAT', rate: 15, taxMode: 'EXCLUSIVE', taxableAmount: 1000, taxAmount: 150, isReverseCharge: true, isWithholding: false }],
    }),
    (err: Error) => { assert.equal(err.name, 'MissingTaxAccountError'); assert.match(err.message, /VAT Payable/); return true },
  )
})

test('a tax-exempt (zero-amount) component never triggers account resolution or a throw', async () => {
  const lines = await buildTaxJournalLines({
    companyId: COMPANY, documentNo: 'BILL-4', documentType: 'BILL', isSales: false,
    components: [{ name: 'VAT', rate: 0, taxMode: 'EXCLUSIVE', taxableAmount: 1000, taxAmount: 0, isReverseCharge: false, isWithholding: false }],
  })
  assert.deepEqual(lines, [])
})
