/**
 * Regression for the NETKOM Journal Entry total-miscomputation defect,
 * discovered during the final migration cleanup audit: QuickBooks reports
 * `TotalAmt: 0` (a literal, defined value) on every JournalEntry, since the
 * field has no real meaning for that entity. `total = value(row.TotalAmt ??
 * row.Amount ?? journalTotal)` never reached the `journalTotal` fallback
 * (nullish-coalescing only falls through on null/undefined, not 0), so
 * `total` was silently 0 for every journal entry regardless of its real
 * debit/credit lines — making `requiresLedgerFor()`'s zero-total exemption
 * fire for every single journal entry in the migration (2283 records),
 * meaning `postQuickBooksJournal` never ran and no journal entry was ever
 * actually posted to the ledger (`status` stuck at `DRAFT`,
 * `posting_sequence` stuck at `null`).
 *
 * The fix: for `resourceKey === 'journal-entries'`, `total` is always the
 * computed `journalTotal` (sum of debit lines), never `row.TotalAmt`.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-journal-entry-total-amount.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)
requireModule('../../scripts/zatca/setup-server-only.cjs')

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://je-total-amount-test.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'anon-test'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-test'

const { QuickBooksImportAdapter } = requireModule('../../src/lib/import-export/sources/quickbooks.adapter') as typeof import('../../src/lib/import-export/sources/quickbooks.adapter')

const REALM = 'realm-je-total-1'

/** Mirrors a real NETKOM journal entry raw payload: TotalAmt is a literal 0. */
function rawJournalEntry(id: string) {
  return {
    Id: id,
    DocNumber: '1107',
    TxnDate: '2024-08-17',
    TotalAmt: 0,
    Line: [
      { Id: '1', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '257' } }, Amount: 140 },
      { Id: '2', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '127' } }, Amount: 140 },
    ],
  }
}

test('a Journal Entry with TotalAmt=0 but real debit/credit lines computes a nonzero total', () => {
  const adapter = new QuickBooksImportAdapter()
  const [row] = adapter.normalizeRecords('journal-entries', [rawJournalEntry('9001')], REALM) as Array<Record<string, unknown>>
  assert.equal(Number(row.total), 140, 'total must reflect the sum of debit lines, not the literal QBO TotalAmt=0')
})

test('a genuinely zero-value Journal Entry (all lines 0) still computes total=0 (no regression)', () => {
  const adapter = new QuickBooksImportAdapter()
  const raw = rawJournalEntry('9002')
  raw.Line = raw.Line.map((l) => ({ ...l, Amount: 0 }))
  const [row] = adapter.normalizeRecords('journal-entries', [raw], REALM) as Array<Record<string, unknown>>
  assert.equal(Number(row.total), 0)
})

test('non-journal resources are unaffected: TotalAmt still wins over a computed fallback', () => {
  const adapter = new QuickBooksImportAdapter()
  const rawExpense = { Id: '9003', DocNumber: 'FT1', TxnDate: '2024-08-17', TotalAmt: 500, Line: [{ Id: '1', AccountBasedExpenseLineDetail: { AccountRef: { value: '50' } }, Amount: 999 }] }
  const [row] = adapter.normalizeRecords('expenses', [rawExpense], REALM) as Array<Record<string, unknown>>
  assert.equal(Number(row.total), 500, 'non-journal resources must keep using TotalAmt, unaffected by this fix')
})
