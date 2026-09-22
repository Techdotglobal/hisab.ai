/**
 * Regression for the account-propagation defects confirmed in the NETKOM migration audit — all four fixes live in
 * `quickbooks.adapter.ts` `normalizeTransaction`, the single function every transaction-shaped QuickBooks entity is
 * normalized through:
 *
 * 1. Vendor-payment settlement account: `CheckPayment.BankAccountRef`/`CreditCardPayment.CCAccountRef` were never
 *    extracted, so every vendor payment's `depositAccountSourceId` was empty and posting fell to the unordered
 *    accounts.bank default (an Equity account on NETKOM's chart). 203 vendor payments were affected.
 * 2. Expense settlement account: the Purchase-header `AccountRef` (the paying account) was never extracted at all.
 *    1,397 expenses were affected.
 * 3. Invoice tax rate: `taxRate` read `valueLine.TaxCodeRef` (the top level of `Line`), but TaxCodeRef is nested inside
 *    the detail object (`SalesItemLineDetail.TaxCodeRef` etc.) — always undefined, so taxRate silently defaulted to "0"
 *    for virtually every invoice line, and `Number.isFinite(0)` being true meant the correct header-derived fallback was
 *    never reached either. SAR 4,682,705.53 of VAT across 556 invoices went missing.
 * 4. Invoice revenue account: `ItemAccountRef` (QuickBooks' resolved income account for a sales item line) was never
 *    included in the line's account-reference fallback chain, so 983 of 998 invoice lines had no account_id and posting
 *    fell to the unordered accounts.revenue default (554 postings landed on Realized FX Gain instead of Sales).
 *
 * This file exercises the REAL `QuickBooksImportAdapter.normalizeRecords` (no DB — pure normalization).
 *
 * Run: npx tsx --test tests/integrations/quickbooks-adapter-account-propagation.test.ts
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { QuickBooksImportAdapter } from '../../src/lib/import-export/sources/quickbooks.adapter'
import { calculateInvoiceTotals } from '../../src/lib/invoices/calculations'

const adapter = new QuickBooksImportAdapter()
const REALM = 'realm-1'
const normalize = (resourceKey: string, row: Record<string, unknown>) => adapter.normalizeRecords(resourceKey, [row], REALM)[0]
const lines = (row: Record<string, string>) => JSON.parse(row.lines) as Array<Record<string, unknown>>

// ---------------------------------------------------------------- 1. vendor-payment settlement account
test('vendor payment: CheckPayment.BankAccountRef becomes depositAccountSourceId', () => {
  const row = normalize('vendor-payments', { Id: '2625', TotalAmt: 8000, VendorRef: { value: '500' }, PayType: 'Check', CheckPayment: { BankAccountRef: { value: '103', name: 'ALBILAD' } }, Line: [] })
  assert.equal(row.depositAccountSourceId, '103')
})

test('vendor payment: CreditCardPayment.CCAccountRef becomes depositAccountSourceId when there is no CheckPayment', () => {
  const row = normalize('vendor-payments', { Id: '9', TotalAmt: 100, VendorRef: { value: '1' }, PayType: 'CreditCard', CreditCardPayment: { CCAccountRef: { value: '393', name: 'Business Debit Card' } }, Line: [] })
  assert.equal(row.depositAccountSourceId, '393')
})

test('vendor payment with no bank/credit-card account reference produces an empty depositAccountSourceId (fails closed downstream, never a silent default)', () => {
  const row = normalize('vendor-payments', { Id: '9', TotalAmt: 100, VendorRef: { value: '1' }, PayType: 'Check', Line: [] })
  assert.equal(row.depositAccountSourceId, '')
})

test('customer payment: DepositToAccountRef is unchanged (existing correct behavior preserved)', () => {
  const row = normalize('customer-payments', { Id: '1', TotalAmt: 100, CustomerRef: { value: '1' }, DepositToAccountRef: { value: '103' }, CheckPayment: { BankAccountRef: { value: 'WRONG' } }, Line: [] })
  assert.equal(row.depositAccountSourceId, '103', 'DepositToAccountRef must win over any vendor-payment-only field')
})

// ---------------------------------------------------------------- 2. expense settlement account
test('expense: header AccountRef becomes settlementAccountSourceId', () => {
  const row = normalize('expenses', { Id: '4513', TotalAmt: 505.75, AccountRef: { value: '103', name: 'ALBILAD' }, PaymentType: 'Check', Line: [] })
  assert.equal(row.settlementAccountSourceId, '103')
})

test('settlementAccountSourceId is scoped to expenses only — a bill\'s own AccountRef does not leak into it', () => {
  const row = normalize('bills', { Id: '1', TotalAmt: 100, VendorRef: { value: '1' }, AccountRef: { value: '999' }, Line: [] })
  assert.equal(row.settlementAccountSourceId, '', 'settlementAccountSourceId only has QuickBooks header-account meaning for expenses')
})

// ---------------------------------------------------------------- 3. invoice tax rate (nested TaxCodeRef)
const salesLine = (amount: number, taxCode: string) => ({ Amount: amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' }, TaxCodeRef: { value: taxCode } } })

test('invoice line taxRate resolves TaxCodeRef nested inside SalesItemLineDetail, not the (always-undefined) Line-level field', () => {
  const row = normalize('invoices', { Id: '3411', TotalAmt: 7393.65, CustomerRef: { value: '1' }, TxnTaxDetail: { TotalTax: 964.39 }, Line: [salesLine(6429.26, '11')] })
  assert.equal(lines(row)[0].taxRate, '11', 'the raw tax-code id is now reachable at all (was always "0" before this fix)')
  assert.equal(lines(row)[0].taxCodeSourceId, '11', 'must match the sibling field that already read the correct nesting')
})

test('a line whose TaxCodeRef truly is only at the top level (AccountBasedExpenseLineDetail-shaped) still resolves via the fallback branch', () => {
  const row = normalize('journal-entries', { Id: '1', Line: [{ Amount: 100, JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '1' } }, TaxCodeRef: { value: '15' } }] })
  assert.equal(lines(row)[0].taxRate, '15')
})

test('a header with no TxnTaxDetail leaves taxRate at 0, not a stale non-zero code id from a prior line', () => {
  const row = normalize('invoices', { Id: '1', TotalAmt: 100, CustomerRef: { value: '1' }, Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } }] })
  assert.equal(lines(row)[0].taxRate, '0')
})

// Reproduces sample invoice 3411 end to end: QuickBooks TotalAmt 7,393.65 = subtotal 6,429.26 + TotalTax 964.39.
// transactions.module.ts's fallbackRate = (taxAmount/subtotal)*100, and calculateInvoiceTotals is the exact pure
// function the real invoice repository uses to compute the STORED total from (quantity, unitPrice, taxRate).
test('invoice source with VAT: the stored total reproduces QBO TotalAmt exactly (SAR 7,393.65 = 6,429.26 + 964.39 VAT)', () => {
  const taxAmount = 964.39, subtotal = 6429.26
  const fallbackRate = subtotal > 0 ? (taxAmount / subtotal) * 100 : 0
  const result = calculateInvoiceTotals([{ quantity: 1, unitPrice: subtotal, taxRate: fallbackRate }], 'TAX_EXCLUSIVE')
  assert.equal(result.subtotal, 6429.26)
  assert.equal(result.taxAmount, 964.39)
  assert.equal(result.total, 7393.65, 'must equal QuickBooks TotalAmt — this was 6,429.26 (0% tax) before the fix')
})

// ---------------------------------------------------------------- 4. invoice revenue account (ItemAccountRef)
test('invoice line accountSourceId resolves from SalesItemLineDetail.ItemAccountRef', () => {
  const row = normalize('invoices', { Id: '1', TotalAmt: 100, CustomerRef: { value: '1' }, Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' }, ItemAccountRef: { value: '77', name: 'Sales' } } }] })
  assert.equal(lines(row)[0].accountSourceId, '77')
  assert.equal(lines(row)[0].accountNo, 'Sales')
})

test('an explicit line-level AccountRef still wins over ItemAccountRef (existing precedence preserved)', () => {
  const row = normalize('invoices', { Id: '1', TotalAmt: 100, CustomerRef: { value: '1' }, Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { AccountRef: { value: 'explicit' }, ItemAccountRef: { value: '77' } } }] })
  assert.equal(lines(row)[0].accountSourceId, 'explicit')
})

test('a sales line with no account reference at all yields an empty accountSourceId (fails closed downstream)', () => {
  const row = normalize('invoices', { Id: '1', TotalAmt: 100, CustomerRef: { value: '1' }, Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } }] })
  assert.equal(lines(row)[0].accountSourceId, '')
})

test('bill/expense line account resolution (AccountBasedExpenseLineDetail.AccountRef) is unaffected by the ItemAccountRef addition', () => {
  const row = normalize('bills', { Id: '1', TotalAmt: 100, VendorRef: { value: '1' }, Line: [{ Amount: 100, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '61' } } }] })
  assert.equal(lines(row)[0].accountSourceId, '61')
})
