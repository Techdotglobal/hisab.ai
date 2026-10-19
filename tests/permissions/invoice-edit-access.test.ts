import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideInvoiceEdit, invoiceAuditSnapshot } from '../../src/lib/invoices/edit-access'

describe('decideInvoiceEdit', () => {
  it('full editors are allowed (posted guard applies downstream)', () => {
    assert.deepEqual(decideInvoiceEdit({ canEdit: true, canEditDrafts: false, currentStatus: 'SENT' }), { allowed: true })
  })
  it('draft editors can change a draft but not move it out of draft', () => {
    assert.deepEqual(decideInvoiceEdit({ canEdit: false, canEditDrafts: true, currentStatus: 'DRAFT' }), { allowed: true })
    assert.deepEqual(decideInvoiceEdit({ canEdit: false, canEditDrafts: true, currentStatus: 'DRAFT', requestedStatus: 'DRAFT' }), { allowed: true })
    const sent = decideInvoiceEdit({ canEdit: false, canEditDrafts: true, currentStatus: 'DRAFT', requestedStatus: 'SENT' })
    assert.equal(sent.allowed, false)
  })
  it('draft editors cannot touch posted, partial or paid invoices', () => {
    for (const status of ['SENT', 'PARTIAL', 'PAID', 'VOID', null]) {
      assert.equal(decideInvoiceEdit({ canEdit: false, canEditDrafts: true, currentStatus: status }).allowed, false, String(status))
    }
  })
  it('no permission means no edit', () => {
    assert.equal(decideInvoiceEdit({ canEdit: false, canEditDrafts: false, currentStatus: 'DRAFT' }).allowed, false)
  })
})

describe('invoiceAuditSnapshot', () => {
  it('records amounts and identifiers only', () => {
    const snap = invoiceAuditSnapshot({ status: 'DRAFT', customerId: 'c1', date: new Date('2026-05-01T00:00:00Z'), subtotal: '100', taxAmount: 15, total: 115, lines: [{}, {}] })
    assert.deepEqual(snap, { status: 'DRAFT', customerId: 'c1', date: '2026-05-01', dueDate: null, subtotal: 100, taxAmount: 15, total: 115, lineCount: 2 })
    assert.equal(invoiceAuditSnapshot(null), null)
  })
})
