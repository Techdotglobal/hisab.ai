import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkDocumentArithmetic, ledgerBalance } from '../../src/lib/reporting/trace-math'

describe('checkDocumentArithmetic', () => {
  const lines = [{ amount: 1000, taxRate: 15 }, { amount: 2000, taxRate: 15 }, { amount: 500, taxRate: 0 }]
  it('reconciles a correct document and shows VAT separately', () => {
    const r = checkDocumentArithmetic(lines, { subtotal: 3500, taxAmount: 450, total: 3950 })
    assert.equal(r.lineSubtotal, 3500)
    assert.equal(r.expectedTax, 450)
    assert.equal(r.ok, true)
  })
  it('flags a stored subtotal that disagrees with the lines (not corrected)', () => {
    const r = checkDocumentArithmetic(lines, { subtotal: 3000, taxAmount: 450, total: 3450 })
    assert.equal(r.ok, false)
    assert.equal(r.checks[0].ok, false)
    assert.equal(r.checks[0].stored, 3000)
    assert.equal(r.checks[0].computed, 3500)
  })
  it('flags total != subtotal + tax', () => {
    assert.equal(checkDocumentArithmetic(lines, { subtotal: 3500, taxAmount: 450, total: 4000 }).ok, false)
  })
})

describe('ledgerBalance', () => {
  it('detects balanced and unbalanced entries', () => {
    assert.equal(ledgerBalance([{ debit: 115, credit: 0 }, { debit: 0, credit: 100 }, { debit: 0, credit: 15 }]).balanced, true)
    assert.equal(ledgerBalance([{ debit: 115, credit: 0 }, { debit: 0, credit: 100 }]).balanced, false)
  })
})
