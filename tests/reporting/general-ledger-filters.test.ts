import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  computePeriodRange, selectionFromDate, validateDateRange, isValidIsoDate,
} from '../../src/lib/reporting/period-presets'
import { isLedgerSourceType, ledgerSourceLabel, LEDGER_SOURCE_TYPES } from '../../src/lib/accounting/ledger-source-types'
import { ledgerRangeBounds, sumDebitCredit, withRunningBalance } from '../../src/lib/accounting/ledger-report-math'
import { matchesAccount } from '../../src/components/data-tools/account-combobox'

describe('computePeriodRange', () => {
  it('monthly covers first to last day, including leap February', () => {
    assert.deepEqual(computePeriodRange('monthly', { year: 2026, month: 1 }), { from: '2026-01-01', to: '2026-01-31' })
    assert.deepEqual(computePeriodRange('monthly', { year: 2026, month: 2 }), { from: '2026-02-01', to: '2026-02-28' })
    assert.deepEqual(computePeriodRange('monthly', { year: 2028, month: 2 }), { from: '2028-02-01', to: '2028-02-29' })
    assert.deepEqual(computePeriodRange('monthly', { year: 1900, month: 2 }), { from: '1900-02-01', to: '1900-02-28' })
    assert.deepEqual(computePeriodRange('monthly', { year: 2026, month: 12 }), { from: '2026-12-01', to: '2026-12-31' })
    assert.deepEqual(computePeriodRange('monthly', { year: 2026, month: 4 }), { from: '2026-04-01', to: '2026-04-30' })
  })
  it('quarterly handles Q1-Q4', () => {
    assert.deepEqual(computePeriodRange('quarterly', { year: 2027, quarter: 1 }), { from: '2027-01-01', to: '2027-03-31' })
    assert.deepEqual(computePeriodRange('quarterly', { year: 2027, quarter: 2 }), { from: '2027-04-01', to: '2027-06-30' })
    assert.deepEqual(computePeriodRange('quarterly', { year: 2027, quarter: 3 }), { from: '2027-07-01', to: '2027-09-30' })
    assert.deepEqual(computePeriodRange('quarterly', { year: 2027, quarter: 4 }), { from: '2027-10-01', to: '2027-12-31' })
  })
  it('half-yearly handles H1 and H2', () => {
    assert.deepEqual(computePeriodRange('half-yearly', { year: 2025, half: 1 }), { from: '2025-01-01', to: '2025-06-30' })
    assert.deepEqual(computePeriodRange('half-yearly', { year: 2025, half: 2 }), { from: '2025-07-01', to: '2025-12-31' })
  })
  it('annually covers the whole selected year, whatever the year', () => {
    assert.deepEqual(computePeriodRange('annually', { year: 2031 }), { from: '2031-01-01', to: '2031-12-31' })
    assert.deepEqual(computePeriodRange('annually', { year: 2019 }), { from: '2019-01-01', to: '2019-12-31' })
  })
  it('returns null for custom and invalid selections', () => {
    assert.equal(computePeriodRange('custom', { year: 2026 }), null)
    assert.equal(computePeriodRange('monthly', { year: 2026, month: 13 }), null)
    assert.equal(computePeriodRange('quarterly', { year: 2026, quarter: 5 }), null)
    assert.equal(computePeriodRange('half-yearly', { year: 2026, half: 3 }), null)
    assert.equal(computePeriodRange('annually', { year: 12 }), null)
  })
  it('seeds selectors from a date', () => {
    assert.deepEqual(selectionFromDate('2026-08-15', 2000), { year: 2026, month: 8, quarter: 3, half: 2 })
    assert.equal(selectionFromDate('', 2030).year, 2030)
  })
})

describe('date validation', () => {
  it('rejects inverted, missing and impossible dates', () => {
    assert.equal(validateDateRange('2026-01-01', '2026-01-01'), null)
    assert.equal(validateDateRange('2026-01-01', '2026-12-31'), null)
    assert.match(validateDateRange('2026-02-01', '2026-01-31') ?? '', /cannot be after/)
    assert.ok(validateDateRange('', '2026-01-31'))
    assert.ok(validateDateRange('2026-02-30', '2026-03-01'))
    assert.equal(isValidIsoDate('2028-02-29'), true)
    assert.equal(isValidIsoDate('2026-02-29'), false)
  })
})

describe('transaction classes', () => {
  it('maps to the ledger source_type enum', () => {
    assert.ok(isLedgerSourceType('INVOICE'))
    assert.ok(isLedgerSourceType('JOURNAL'))
    assert.equal(isLedgerSourceType('invoice'), false)
    assert.equal(isLedgerSourceType("INVOICE'; drop"), false)
    assert.equal(ledgerSourceLabel('BILL'), 'Bill')
    assert.equal(new Set(LEDGER_SOURCE_TYPES.map((t) => t.value)).size, LEDGER_SOURCE_TYPES.length)
  })
})

describe('ledger balances', () => {
  const rows = [
    { debit: 100, credit: 0 },
    { debit: 0, credit: 30.5 },
    { debit: 10.25, credit: 0 },
  ]
  it('date-only bounds include the whole last day', () => {
    assert.deepEqual(ledgerRangeBounds('2026-03-01', '2026-03-31'), { fromIso: '2026-03-01T00:00:00.000Z', toIso: '2026-03-31T23:59:59.999Z' })
  })
  it('running balance starts at the opening balance', () => {
    const out = withRunningBalance(rows, 500)
    assert.deepEqual(out.map((r) => r.balance), [600, 569.5, 579.75])
  })
  it('paging: second page continues from opening + prior rows, closing = opening + debits - credits', () => {
    const opening = 500
    const { debit, credit } = sumDebitCredit(rows)
    const page1 = withRunningBalance(rows.slice(0, 2), opening)
    const priorNet = sumDebitCredit(rows.slice(0, 2))
    const page2 = withRunningBalance(rows.slice(2), opening + priorNet.debit - priorNet.credit)
    assert.equal(page2[0].balance, withRunningBalance(rows, opening)[2].balance)
    assert.equal(page2[0].balance, opening + debit - credit)
    assert.equal(page1.length + page2.length, rows.length)
  })
  it('avoids float drift', () => {
    const many = Array.from({ length: 1000 }, () => ({ debit: 0.1, credit: 0 }))
    assert.equal(withRunningBalance(many, 0)[999].balance, 100)
    assert.equal(sumDebitCredit(many).debit, 100)
  })
})

describe('account search', () => {
  const acct = { id: '1', accountNo: '1010', name: 'Cash on Hand', fullName: 'Assets:Cash on Hand' }
  it('matches name, code and full name, case-insensitively', () => {
    assert.ok(matchesAccount(acct, 'cash'))
    assert.ok(matchesAccount(acct, '1010'))
    assert.ok(matchesAccount(acct, 'ASSETS:'))
    assert.ok(matchesAccount(acct, '  '))
    assert.equal(matchesAccount(acct, 'payable'), false)
  })
})
