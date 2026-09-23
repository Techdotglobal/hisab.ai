import assert from 'node:assert/strict'
import test from 'node:test'
import { extractQuickBooksPaymentRelationships } from '../../src/lib/import-export/quickbooks/payment-relationships'

const target = (amount: number, type: string, id: string) => ({ Amount: amount, LinkedTxn: [{ TxnType: type, TxnId: id }] })
const credit = (amount: number, type: string, id: string) => ({ Amount: amount, LinkedTxn: [{ TxnType: type, TxnId: id }] })
const cents = (value: number) => Math.round(value * 100)

function assertCertifiable(result: ReturnType<typeof extractQuickBooksPaymentRelationships>) {
  const keys = new Set<string>()
  for (const allocation of result.allocations) {
    // Preconditions enforced by replacePaymentAllocations and the payment_allocations table.
    if (allocation.creditAmount > 0) assert.equal(allocation.creditSourceIds.length, 1, allocation.sourceLineKey)
    assert.equal(cents(allocation.amount), cents(allocation.cashAmount + allocation.creditAmount), allocation.sourceLineKey)
    assert.ok(allocation.amount > 0)
    const key = `${allocation.sourceLineKey}:${allocation.targetSourceId}`
    assert.ok(!keys.has(key), `duplicate allocation key ${key}`)
    keys.add(key)
  }
}

// Shape of NETKOM Customer Payment 4693: the first QuickBooks line is the large cash-settled invoice, the second line
// is an invoice settled entirely by six credit memos that QuickBooks lists as stand-alone lines.
const payment4693 = () => ({
  TotalAmt: 338418.41,
  UnappliedAmt: 0,
  Line: [
    target(338418.41, 'Invoice', '4685'),
    target(18238.1, 'Invoice', '4559'),
    credit(1643.81, 'CreditMemo', '4421'),
    credit(3223.22, 'CreditMemo', '4422'),
    credit(2530.92, 'CreditMemo', '4423'),
    credit(3223.22, 'CreditMemo', '4424'),
    credit(5903.08, 'CreditMemo', '4425'),
    credit(1713.85, 'CreditMemo', '4426'),
  ],
})

test('payment 4693: credit memos are paired to the invoice whose amount they exactly settle, not the first line', () => {
  const result = extractQuickBooksPaymentRelationships(payment4693(), 'CUSTOMER')
  assert.deepEqual(result.issues, [])
  assertCertifiable(result)

  const cash = result.allocations.filter((item) => item.targetSourceId === '4685')
  assert.equal(cash.length, 1)
  assert.equal(cash[0].sourceLineKey, 'line:0:Invoice:4685')
  assert.equal(cash[0].cashAmount, 338418.41)
  assert.equal(cash[0].creditAmount, 0)
  assert.deepEqual(cash[0].creditSourceIds, [])

  const credited = result.allocations.filter((item) => item.targetSourceId === '4559')
  assert.equal(credited.length, 6)
  assert.deepEqual(credited.map((item) => item.creditSourceIds[0]), ['4421', '4422', '4423', '4424', '4425', '4426'])
  assert.deepEqual(credited.map((item) => item.amount), [1643.81, 3223.22, 2530.92, 3223.22, 5903.08, 1713.85])
  assert.ok(credited.every((item) => item.cashAmount === 0 && item.creditAmount === item.amount))
  // Splitting must not change what the invoice is credited with.
  assert.equal(cents(credited.reduce((sum, item) => sum + item.amount, 0)), cents(18238.1))

  assert.equal(result.appliedAmount, 338418.41)
  assert.equal(result.creditAppliedAmount, 18238.1)
  assert.equal(result.unappliedAmount, 0)
  assert.equal(result.paymentAmount, 338418.41)
})

test('payment 4693: extraction is deterministic across repeated runs', () => {
  const first = JSON.stringify(extractQuickBooksPaymentRelationships(payment4693(), 'CUSTOMER'))
  const second = JSON.stringify(extractQuickBooksPaymentRelationships(payment4693(), 'CUSTOMER'))
  assert.equal(first, second)
})

test('credit lines that come before the invoice line are paired the same way', () => {
  const raw = payment4693()
  const reordered = { ...raw, Line: [...raw.Line.slice(2), ...raw.Line.slice(0, 2)] }
  const result = extractQuickBooksPaymentRelationships(reordered, 'CUSTOMER')
  assert.deepEqual(result.issues, [])
  assert.equal(result.allocations.filter((item) => item.targetSourceId === '4559').length, 6)
  assert.equal(result.creditAppliedAmount, 18238.1)
})

test('existing payments the order-based pairing already certifies keep byte-identical allocations', () => {
  // Mixed cash/credit lines (the NETKOM 2770 / 3011 pattern): partially credited invoices cannot be re-derived from
  // amounts, so the original pairing must be left exactly as it was.
  const mixed = extractQuickBooksPaymentRelationships({
    TotalAmt: 150, UnappliedAmt: 0,
    Line: [target(100, 'Invoice', 'A'), target(200, 'Invoice', 'B'), credit(150, 'CreditMemo', 'CM-1')],
  }, 'CUSTOMER')
  assert.deepEqual(mixed.issues, [])
  assert.deepEqual(mixed.allocations.map((item) => [item.sourceLineKey, item.amount, item.cashAmount, item.creditAmount, item.creditSourceIds]), [
    ['line:0:Invoice:A', 100, 0, 100, ['CM-1']],
    ['line:1:Invoice:B', 200, 150, 50, ['CM-1']],
  ])

  const single = extractQuickBooksPaymentRelationships({ TotalAmt: 100, UnappliedAmt: 0, Line: [target(130, 'Invoice', 'INV-1', ), credit(30, 'CreditMemo', 'CM-9')] }, 'CUSTOMER')
  assert.deepEqual(single.issues, [])
  assert.deepEqual(single.allocations.map((item) => [item.sourceLineKey, item.cashAmount, item.creditAmount, item.creditSourceIds]), [['line:0:Invoice:INV-1', 100, 30, ['CM-9']]])

  // A single credit that the original pairing already assigns validly is not re-paired by amount, even if an exact
  // amount match exists further down: that would silently rewrite allocations that are already materialized.
  const orderBased = extractQuickBooksPaymentRelationships({
    TotalAmt: 200, UnappliedAmt: 0,
    Line: [target(200, 'Invoice', 'BIG'), target(100, 'Invoice', 'SMALL'), credit(100, 'CreditMemo', 'CM-1')],
  }, 'CUSTOMER')
  assert.deepEqual(orderBased.issues, [])
  assert.deepEqual(orderBased.allocations.map((item) => [item.sourceLineKey, item.cashAmount, item.creditAmount]), [['line:0:Invoice:BIG', 100, 100], ['line:1:Invoice:SMALL', 100, 0]])
})

test('explicit credits on a payment line and zero-cash credit linking payments are untouched', () => {
  const explicit = extractQuickBooksPaymentRelationships({ TotalAmt: 100, Line: [{ Amount: 130, LinkedTxn: [{ TxnType: 'Invoice', TxnId: 'INV-1' }, { TxnType: 'CreditMemo', TxnId: 'CM-7' }] }] }, 'CUSTOMER')
  assert.deepEqual(explicit.issues, [])
  assert.deepEqual(explicit.allocations[0].creditSourceIds, ['CM-7'])
  assert.equal(explicit.allocations[0].sourceLineKey, 'line:0:Invoice:INV-1')

  const linking = extractQuickBooksPaymentRelationships({ TotalAmt: 0, UnappliedAmt: 0, Line: [target(100, 'Invoice', 'INV-1'), credit(100, 'CreditMemo', 'CM-7')] }, 'CUSTOMER')
  assert.deepEqual(linking.issues, [])
  assert.equal(linking.allocations.length, 1)
  assert.equal(linking.allocations[0].sourceLineKey, 'line:0:Invoice:INV-1')

  const twoExplicit = extractQuickBooksPaymentRelationships({ TotalAmt: 100, Line: [{ Amount: 130, LinkedTxn: [{ TxnType: 'Invoice', TxnId: 'INV-1' }, { TxnType: 'CreditMemo', TxnId: 'CM-1' }, { TxnType: 'CreditMemo', TxnId: 'CM-2' }] }] }, 'CUSTOMER')
  assert.match(twoExplicit.issues.join(' '), /exactly one credit/)
})

test('amount-based matching wins when line order and amount order differ', () => {
  const result = extractQuickBooksPaymentRelationships({
    TotalAmt: 500, UnappliedAmt: 0,
    Line: [target(500, 'Invoice', 'LARGE'), target(90, 'Invoice', 'SMALL'), credit(40, 'CreditMemo', 'CM-1'), credit(50, 'CreditMemo', 'CM-2')],
  }, 'CUSTOMER')
  assert.deepEqual(result.issues, [])
  assertCertifiable(result)
  assert.deepEqual(result.allocations.map((item) => [item.targetSourceId, item.amount, item.cashAmount, item.creditAmount, item.creditSourceIds]), [
    ['LARGE', 500, 500, 0, []],
    ['SMALL', 40, 0, 40, ['CM-1']],
    ['SMALL', 50, 0, 50, ['CM-2']],
  ])
})

test('a single exact-match credit on a later line is paired when the first line cannot absorb it', () => {
  const result = extractQuickBooksPaymentRelationships({
    TotalAmt: 300, UnappliedAmt: 0,
    Line: [target(300, 'Invoice', 'A'), target(70, 'Invoice', 'B'), credit(30, 'CreditMemo', 'CM-1'), credit(40, 'CreditMemo', 'CM-2')],
  }, 'CUSTOMER')
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.allocations.filter((item) => item.creditAmount > 0).map((item) => item.targetSourceId), ['B', 'B'])
  assert.equal(result.allocations[0].cashAmount, 300)
})

test('two credits that settle two different invoices exactly are each paired uniquely by amount', () => {
  const result = extractQuickBooksPaymentRelationships({
    TotalAmt: 1000, UnappliedAmt: 0,
    Line: [target(1000, 'Invoice', 'CASH'), target(25, 'Invoice', 'I1'), target(75, 'Invoice', 'I2'), credit(75, 'CreditMemo', 'CM-A'), credit(25, 'CreditMemo', 'CM-B')],
  }, 'CUSTOMER')
  assert.deepEqual(result.issues, [])
  assertCertifiable(result)
  const byTarget = Object.fromEntries(result.allocations.map((item) => [item.targetSourceId, item.creditSourceIds]))
  assert.deepEqual(byTarget, { CASH: [], I1: ['CM-B'], I2: ['CM-A'] })
})

test('ambiguous amounts fail closed: two invoices of equal size could each be the credited one', () => {
  const result = extractQuickBooksPaymentRelationships({
    TotalAmt: 100, UnappliedAmt: 0,
    Line: [target(100, 'Invoice', 'INV-1'), target(100, 'Invoice', 'INV-2'), credit(40, 'CreditMemo', 'CM-1'), credit(60, 'CreditMemo', 'CM-2')],
  }, 'CUSTOMER')
  assert.match(result.issues.join(' '), /exactly one credit/)
  assert.equal(result.allocations.length, 2)
  assert.ok(result.allocations.every((item) => !item.sourceLineKey.includes(':credit:')))
})

test('ambiguous credit amounts fail closed: identical credits could belong to either equally sized invoice', () => {
  const result = extractQuickBooksPaymentRelationships({
    TotalAmt: 100, UnappliedAmt: 0,
    Line: [target(100, 'Invoice', 'INV-1'), target(50, 'Invoice', 'INV-2'), target(50, 'Invoice', 'INV-3'), credit(50, 'CreditMemo', 'CM-1'), credit(50, 'CreditMemo', 'CM-2')],
  }, 'CUSTOMER')
  assert.notDeepEqual(result.issues, [])
})

test('insufficient amount correlation fails closed rather than inventing a pairing', () => {
  // 90 of credit is applied, but no combination of invoice amounts is exactly settled by the credit lines.
  const result = extractQuickBooksPaymentRelationships({
    TotalAmt: 40, UnappliedAmt: 0,
    Line: [target(60, 'Invoice', 'A'), target(70, 'Invoice', 'B'), credit(50, 'CreditMemo', 'CM-1'), credit(40, 'CreditMemo', 'CM-2')],
  }, 'CUSTOMER')
  assert.match(result.issues.join(' '), /exactly one credit/)
  assert.ok(result.allocations.every((item) => !item.sourceLineKey.includes(':credit:')))
})

test('credit lines that do not total the applied credit fail closed', () => {
  const result = extractQuickBooksPaymentRelationships({
    TotalAmt: 0, UnappliedAmt: 0,
    Line: [target(90, 'Invoice', 'A'), credit(60, 'CreditMemo', 'CM-1'), credit(40, 'CreditMemo', 'CM-2')],
  }, 'CUSTOMER')
  assert.notDeepEqual(result.issues, [])
})

test('payment lines with ambiguous targets are never rescued by credit correlation', () => {
  const result = extractQuickBooksPaymentRelationships({
    TotalAmt: 100, UnappliedAmt: 0,
    Line: [{ Amount: 10, LinkedTxn: [{ TxnType: 'Invoice', TxnId: 'X' }, { TxnType: 'Invoice', TxnId: 'Y' }] }, target(90, 'Invoice', 'B'), credit(90, 'CreditMemo', 'CM-1')],
  }, 'CUSTOMER')
  assert.match(result.issues.join(' '), /ambiguous/)
})

test('oversized correlation problems fail closed instead of searching unbounded', () => {
  const lines: unknown[] = [target(1000, 'Invoice', 'CASH')]
  for (let index = 0; index < 20; index++) lines.push(target(10, 'Invoice', `I${index}`), credit(10, 'CreditMemo', `CM-${index}`))
  const result = extractQuickBooksPaymentRelationships({ TotalAmt: 1000, UnappliedAmt: 0, Line: lines }, 'CUSTOMER')
  assert.ok(result.allocations.every((item) => !item.sourceLineKey.includes(':credit:')))
})

test('vendor payments use the same exact-amount pairing for vendor credits', () => {
  const result = extractQuickBooksPaymentRelationships({
    TotalAmt: 400, UnappliedAmt: 0,
    Line: [target(400, 'Bill', 'B-1'), target(30, 'Bill', 'B-2'), credit(10, 'VendorCredit', 'VC-1'), credit(20, 'VendorCredit', 'VC-2')],
  }, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assertCertifiable(result)
  assert.deepEqual(result.allocations.filter((item) => item.creditAmount > 0).map((item) => [item.targetSourceId, item.creditSourceIds[0], item.creditAmount]), [['B-2', 'VC-1', 10], ['B-2', 'VC-2', 20]])
})

test('vendor payments that do not carry a vendor-credit relationship are unaffected', () => {
  const result = extractQuickBooksPaymentRelationships({ TotalAmt: 100, Line: [target(45, 'Bill', 'BILL-1'), target(55, 'Bill', 'BILL-2')] }, 'VENDOR')
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.allocations.map((item) => item.sourceLineKey), ['line:0:Bill:BILL-1', 'line:1:Bill:BILL-2'])

  // A payment line whose only link is a Journal Entry (no Bill) now settles that JE-originated AP liability directly
  // (Phase 2 item 4: the 29 JE-linked vendor payments) instead of failing closed with no allocation at all.
  const jeLinked = extractQuickBooksPaymentRelationships({ TotalAmt: 5000, UnappliedAmt: 0, Line: [{ Amount: 5000, LinkedTxn: [{ TxnType: 'JournalEntry', TxnId: '2671' }] }] }, 'VENDOR')
  assert.deepEqual(jeLinked.issues, [])
  assert.equal(jeLinked.allocations.length, 1)
  assert.equal(jeLinked.allocations[0].targetType, 'JournalEntry')
  assert.equal(jeLinked.allocations[0].targetSourceId, '2671')
  assert.equal(jeLinked.allocations[0].amount, 5000)
})
