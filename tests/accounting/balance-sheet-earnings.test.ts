import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { unclosedEarnings } from '../../src/lib/accounting/balance-sheet-math'

describe('unclosedEarnings', () => {
  it('is Income − COGS − Expense using signed balances', () => {
    assert.equal(unclosedEarnings([
      { canonicalType: 'Income', balance: 1000 },
      { canonicalType: 'CostOfGoodsSold', balance: 300 },
      { canonicalType: 'Expense', balance: 200 },
      { canonicalType: 'Asset', balance: 99999 },
    ]), 500)
  })
  it('is negative for a loss and zero once closed', () => {
    assert.equal(unclosedEarnings([{ canonicalType: 'Expense', balance: 40 }]), -40)
    assert.equal(unclosedEarnings([{ canonicalType: 'Income', balance: 0 }, { canonicalType: 'Expense', balance: 0 }]), 0)
  })
  it('makes assets = liabilities + equity when profit is still open', () => {
    // cash 700 (asset), loan 200 (liability), capital 300 (equity), earnings 200 unclosed
    const assets = 700, liabilities = 200, equity = 300
    const earnings = unclosedEarnings([{ canonicalType: 'Income', balance: 500 }, { canonicalType: 'Expense', balance: 300 }])
    assert.equal(assets, liabilities + equity + earnings)
  })
})
