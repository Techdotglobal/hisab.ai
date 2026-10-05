import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { invoiceLineRevenueAccount } from '../../src/lib/accounting/document-posting'
import { formatChartOfAccountLabel, postableInvoiceLineAccounts } from '../../src/lib/invoices/line-accounts'

// Shaped like production chart_of_accounts rows for NETKOM (values read read-only).
const production = [
  { id: 'uuid-41', accountNo: '41', name: 'INCOME', fullName: 'INCOME', legacyId: '242', accountType: 'Income', subType: 'SalesOfProductIncome', parentNo: null, isActive: true },
  { id: 'uuid-41-4101', accountNo: '41-4101', name: 'REVENUE AND OTHER INCOME', fullName: 'INCOME:REVENUE AND OTHER INCOME', legacyId: '243', accountType: 'Income', subType: 'SalesOfProductIncome', parentNo: '41', isActive: true },
  { id: 'uuid-410101', accountNo: '41-4101-410101', name: 'SALES INCOME', fullName: 'INCOME:REVENUE AND OTHER INCOME:SALES INCOME', legacyId: '244', accountType: 'Income', subType: 'SalesOfProductIncome', parentNo: '41-4101', isActive: true },
  { id: 'uuid-qb2', accountNo: 'QB-2', name: 'Uncategorised Income', fullName: 'Uncategorised Income', legacyId: '2', accountType: 'Income', subType: 'SalesOfProductIncome', parentNo: null, isActive: true },
  { id: 'uuid-qb10', accountNo: 'QB-10', name: 'Sales - retail (deleted)', fullName: 'Sales - retail (deleted)', legacyId: '10', accountType: 'Income', subType: 'SalesRetail', parentNo: null, isActive: false },
  { id: 'uuid-1101', accountNo: '11-1101', name: 'Cash and Bank', fullName: 'ASSETS:Cash and Bank', legacyId: null, accountType: 'Bank', subType: 'Cash', parentNo: '11', isActive: true },
]

describe('chart of account label', () => {
  it('shows canonical account_no and name only', () => {
    assert.equal(formatChartOfAccountLabel(production[2]), '41-4101-410101 · SALES INCOME')
  })

  it('never uses full_name, legacy_id or the internal UUID', () => {
    const label = formatChartOfAccountLabel(production[2])
    assert.doesNotMatch(label, /INCOME:/)
    assert.doesNotMatch(label, /244/)
    assert.doesNotMatch(label, /uuid/)
  })
})

describe('postable Chart of Accounts for invoice lines', () => {
  it('offers leaf Income accounts only', () => {
    const ids = postableInvoiceLineAccounts(production).map((a) => a.id)
    assert.deepEqual(ids, ['uuid-410101', 'uuid-qb2'])
  })

  it('hides group accounts that other active accounts roll up into', () => {
    const ids = postableInvoiceLineAccounts(production).map((a) => a.id)
    assert.equal(ids.includes('uuid-41'), false)
    assert.equal(ids.includes('uuid-41-4101'), false)
  })

  it('hides inactive, header and non-income accounts', () => {
    const header = { ...production[3], id: 'uuid-hdr', subType: 'Header' }
    const ids = postableInvoiceLineAccounts([...production, header]).map((a) => a.id)
    assert.equal(ids.includes('uuid-qb10'), false)
    assert.equal(ids.includes('uuid-hdr'), false)
    assert.equal(ids.includes('uuid-1101'), false)
  })

  it('orders options by account number', () => {
    const numbers = postableInvoiceLineAccounts(production).map((a) => a.accountNo)
    assert.deepEqual(numbers, ['41-4101-410101', 'QB-2'].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
  })
})

describe('invoice line revenue posting uses the selected account', () => {
  it('selected chart of account is the revenue account', () => {
    assert.equal(invoiceLineRevenueAccount('uuid-410101', 'uuid-default'), 'uuid-410101')
  })

  it('default revenue is used only when the line has no account', () => {
    assert.equal(invoiceLineRevenueAccount(null, 'uuid-default'), 'uuid-default')
    assert.equal(invoiceLineRevenueAccount(undefined, 'uuid-default'), 'uuid-default')
    assert.equal(invoiceLineRevenueAccount('', 'uuid-default'), 'uuid-default')
  })

  it('two lines post to their own accounts independently', () => {
    const lines = [{ account_id: 'uuid-410101' }, { account_id: 'uuid-qb2' }, { account_id: null }]
    const posted = lines.map((line) => invoiceLineRevenueAccount(line.account_id, 'uuid-default'))
    assert.deepEqual(posted, ['uuid-410101', 'uuid-qb2', 'uuid-default'])
  })
})

describe('form and posting wiring', () => {
  const form = readFileSync('src/components/invoices/invoice-create-form.tsx', 'utf8').replace(/\r\n/g, '\n')
  const posting = readFileSync('src/lib/accounting/document-posting.ts', 'utf8').replace(/\r\n/g, '\n')
  const page = readFileSync('src/app/(dashboard)/invoices/page.tsx', 'utf8').replace(/\r\n/g, '\n')

  it('column is labelled Chart of Account', () => {
    assert.match(form, /label: 'Chart of Account'/)
    assert.doesNotMatch(form, /label: 'Account'/)
  })

  it('option text and title come from the shared label formatter', () => {
    assert.match(form, /<option key=\{a\.id\} value=\{a\.id\}>\{formatChartOfAccountLabel\(a\)\}<\/option>/)
    assert.match(form, /return selected \? formatChartOfAccountLabel\(selected\) : undefined/)
    assert.doesNotMatch(form, /accountNo\} · \{/)
  })

  it('form never displays full_name, legacy_id, or the stored id', () => {
    assert.doesNotMatch(form, /fullName|legacyId|legacy_id/)
  })

  it('posting selects the line account through the shared helper', () => {
    assert.match(posting, /const accountId = invoiceLineRevenueAccount\(line\.account_id, revenueAccount\)/)
  })

  it('edit restores the stored account id', () => {
    assert.match(page, /accountId: line\.accountId \?\? ''/)
  })
})
