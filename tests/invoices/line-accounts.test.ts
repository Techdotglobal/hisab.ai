import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { postableInvoiceLineAccounts } from '../../src/lib/invoices/line-accounts'

const accounts = [
  { id: 'a10', accountNo: '10', name: 'Consulting', accountType: 'Income', isActive: true },
  { id: 'a2', accountNo: '2', name: 'Product sales', accountType: 'Income', isActive: true },
  { id: 'bank', accountNo: '1000', name: 'Main bank', accountType: 'Bank', isActive: true },
  { id: 'old', accountNo: '3', name: 'Retired income', accountType: 'Income', isActive: false },
  { id: 'exp', accountNo: '50', name: 'Rent', accountType: 'Expenses', isActive: true },
]

describe('invoice line account selection', () => {
  it('offers only active Income accounts', () => {
    const ids = postableInvoiceLineAccounts(accounts).map((a) => a.id)
    assert.deepEqual(ids, ['a2', 'a10'])
  })

  it('sorts accounts by numeric account number', () => {
    const ordered = postableInvoiceLineAccounts(accounts).map((a) => a.accountNo)
    assert.deepEqual(ordered, ['2', '10'])
  })

  it('returns an empty list when no income accounts exist', () => {
    assert.deepEqual(postableInvoiceLineAccounts([accounts[2], accounts[4]]), [])
  })

  it('does not mutate the caller array', () => {
    const copy = [...accounts]
    postableInvoiceLineAccounts(copy)
    assert.deepEqual(copy.map((a) => a.id), accounts.map((a) => a.id))
  })
})

describe('invoice create form line account wiring', () => {
  const source = readFileSync('src/components/invoices/invoice-create-form.tsx', 'utf8')

  it('renders an Account selector per line that writes accountId to that line only', () => {
    assert.match(source, /value=\{line\.accountId\}/)
    assert.match(source, /onChange=\{\(e\) => updateLine\(idx, \{ accountId: e\.target\.value \}\)\}/)
  })

  it('keeps the Chart of Account column between Description and Project / Service', () => {
    const description = source.indexOf("{ label: 'Description'")
    const account = source.indexOf("{ label: 'Chart of Account'")
    const project = source.indexOf("{ label: 'Project / Service'")
    assert.ok(description > 0 && account > description && project > account)
  })

  it('keeps an already-saved account visible when it is no longer postable', () => {
    assert.match(source, /selected && !postable\.some\(\(a\) => a\.id === selected\.id\)/)
  })
})
