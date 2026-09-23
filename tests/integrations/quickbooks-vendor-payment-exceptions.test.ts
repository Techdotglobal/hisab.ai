/**
 * The "5 vendor-payment exceptions" (BillPayment 4903, 4945, 4965, 4967, 5032): investigated against the live
 * archived QuickBooks payload. All 5 share the same root cause and it is NOT a business-decision judgment call:
 *
 *   - None of the 5 carry a `UnappliedAmt` field at all — not 0, genuinely absent from the payload (unlike every
 *     other certified payment in this dataset, which always has it, even when it's 0).
 *   - Every Line is a plain Bill-linked line (no VendorCredit, no JournalEntry) whose amounts sum to LESS than
 *     TotalAmt.
 *   - QuickBooks' own invariant for a Payment is `TotalAmt = SUM(Line.Amount) + UnappliedAmt`. With the field
 *     missing, `TotalAmt - SUM(Line.Amount)` is the only value consistent with QuickBooks' own numbers — genuinely
 *     unapplied/on-account cash, not a guess about which bill absorbs it (none does).
 *
 * Confirmed treatment per payment (live QuickBooks payload, company 05585a44-672d-4bab-aa40-6dfe022c19a0, realm
 * 9130356995984366 — read-only investigation, no production data changed):
 *   - 4903 (NK Payroll):        3 Bills fully cash (4630, 4759, 4523); SAR 190.00 unapplied/on-account.
 *   - 4945 (Royale Blue):       5 Bills fully cash (4768, 4832, 4833, 4834, 4766); SAR 34,572.72 unapplied.
 *   - 4965 (United Baset Est.): 1 Bill fully cash (4767); SAR 2,941.58 unapplied.
 *   - 4967 (Royale Blue):       ZERO Line entries at all — a fully unapplied/on-account advance payment
 *                               (SAR 25,000.00), no Bill target whatsoever.
 *   - 5032 (NK Payroll):        1 Bill fully cash (4975); SAR 4,280.00 unapplied.
 *
 * The fix (payment-relationships.ts `resolveReportedUnapplied`) closes all 5 deterministically — no guessing about
 * WHICH bill the shortfall belongs to, since none of it belongs to any bill; it is on-account cash, which is exactly
 * what `unappliedAmount`/`unapplied_amount` already models. An explicit `UnappliedAmt: 0` is untouched.
 *
 * This file locks in the exact real payload shapes so no future change silently re-blocks these 5 payments. It also
 * covers the payment 2625 discovery this same investigation depended on being correct (see
 * quickbooks-je-linked-vendor-payments.test.ts for the full payment-2625 regression).
 *
 * Run: npx tsx --test tests/integrations/quickbooks-vendor-payment-exceptions.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractQuickBooksPaymentRelationships } from '../../src/lib/import-export/quickbooks/payment-relationships'

test('an explicit UnappliedAmt: 0 is never touched by the missing-field inference, even when lines fall short of TotalAmt (fails closed as before)', () => {
  const result = extractQuickBooksPaymentRelationships({ TotalAmt: 100, UnappliedAmt: 0, Line: [{ Amount: 60, LinkedTxn: [{ TxnType: 'Bill', TxnId: 'B-1' }] }] }, 'VENDOR')
  assert.equal(result.unappliedAmount, 0)
  assert.notDeepEqual(result.issues, [], 'an explicit 0 must still fail closed on an unexplained shortfall')
})

test('4903 (NK Payroll): 3 Bills fully cash, SAR 190.00 correctly inferred as unapplied/on-account', () => {
  const raw = {
    Id: '4903', TotalAmt: 10057,
    VendorRef: { value: '649', name: 'NK Payroll' },
    Line: [
      { Amount: 7257, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4630' }] },
      { Amount: 210, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4759' }] },
      { Amount: 2400, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4523' }] },
    ],
  }
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'UnappliedAmt'), false, 'this payload genuinely has no UnappliedAmt field')
  const result = extractQuickBooksPaymentRelationships(raw, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.equal(result.unappliedAmount, 190)
  assert.equal(result.allocations.length, 3)
  for (const alloc of result.allocations) { assert.equal(alloc.creditAmount, 0); assert.equal(alloc.cashAmount, alloc.amount) }
  assert.equal(result.appliedAmount, 9867)
})

test('4945 (Royale Blue): 5 Bills fully cash, SAR 34,572.72 unapplied', () => {
  const raw = {
    Id: '4945', TotalAmt: 342735,
    VendorRef: { value: '550', name: 'Royale Blue (Hamza Kafeel)' },
    Line: [
      { Amount: 57699.39, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4768' }] },
      { Amount: 59042, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4832' }] },
      { Amount: 98393.89, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4833' }] },
      { Amount: 68027, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4834' }] },
      { Amount: 25000, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4766' }] },
    ],
  }
  const result = extractQuickBooksPaymentRelationships(raw, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.equal(result.unappliedAmount, 34572.72)
  assert.equal(result.allocations.length, 5)
  assert.equal(result.appliedAmount, 308162.28)
})

test('4965 (United Baset Est.): 1 Bill fully cash, SAR 2,941.58 unapplied', () => {
  const raw = {
    Id: '4965', TotalAmt: 45800,
    VendorRef: { value: '500', name: 'United Baset Est. (Toyota Hilux)' },
    Line: [{ Amount: 42858.42, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4767' }] }],
  }
  const result = extractQuickBooksPaymentRelationships(raw, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.equal(result.unappliedAmount, 2941.58)
  assert.equal(result.allocations.length, 1)
  assert.equal(result.allocations[0].targetSourceId, '4767')
  assert.equal(result.allocations[0].cashAmount, 42858.42)
})

test('4967 (Royale Blue): zero Line entries — a fully unapplied advance payment, no Bill target at all', () => {
  const raw = { Id: '4967', TotalAmt: 25000, VendorRef: { value: '550', name: 'Royale Blue (Hamza Kafeel)' }, Line: [] }
  const result = extractQuickBooksPaymentRelationships(raw, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.equal(result.unappliedAmount, 25000)
  assert.equal(result.allocations.length, 0, 'no allocation is invented for a payment with no LinkedTxn at all')
  assert.equal(result.appliedAmount, 0)
})

test('5032 (NK Payroll): 1 Bill fully cash, SAR 4,280.00 unapplied', () => {
  const raw = {
    Id: '5032', TotalAmt: 5500,
    VendorRef: { value: '649', name: 'NK Payroll' },
    Line: [{ Amount: 1220, LinkedTxn: [{ TxnType: 'Bill', TxnId: '4975' }] }],
  }
  const result = extractQuickBooksPaymentRelationships(raw, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.equal(result.unappliedAmount, 4280)
  assert.equal(result.allocations.length, 1)
  assert.equal(result.allocations[0].cashAmount, 1220)
})

test('the missing-UnappliedAmt inference is VENDOR/CUSTOMER-symmetric (uses raw Line sum, not just resolvable targets)', () => {
  const raw = { TotalAmt: 500, Line: [{ Amount: 300, LinkedTxn: [{ TxnType: 'Invoice', TxnId: 'INV-1' }] }] }
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'UnappliedAmt'), false)
  const result = extractQuickBooksPaymentRelationships(raw, 'CUSTOMER')
  assert.deepEqual(result.issues, [])
  assert.equal(result.unappliedAmount, 200)
})
