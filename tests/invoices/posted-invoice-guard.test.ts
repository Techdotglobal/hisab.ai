import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  changedPostedInvoiceFields,
  isPostedInvoiceStatus,
  postedLineSignature,
  type PostedLineSignature,
} from '../../src/lib/invoices/posted-guard'

const baseLine: PostedLineSignature = {
  description: 'Consulting',
  quantity: 2,
  unitPrice: 100,
  taxRate: 15,
  taxRateId: 'tax-15',
  accountId: 'acct-A',
  projectId: 'proj-A',
  classId: 'class-A',
  locationId: 'loc-A',
  costCenterId: null,
  inventoryItemId: null,
  itemName: 'Consulting',
  amount: 200,
}

describe('posted invoice status', () => {
  it('treats SENT and PARTIAL as posted; DRAFT and PAID are not governed by this rule', () => {
    assert.equal(isPostedInvoiceStatus('SENT'), true)
    assert.equal(isPostedInvoiceStatus('PARTIAL'), true)
    assert.equal(isPostedInvoiceStatus('DRAFT'), false)
    assert.equal(isPostedInvoiceStatus('PAID'), false)
    assert.equal(isPostedInvoiceStatus(null), false)
  })
})

describe('posted invoice field comparison', () => {
  const stored = { customer: 'c1', date: '2026-09-01', amount: 200, status: 'SENT' }

  it('an unchanged re-save of every submitted field is not a change', () => {
    assert.deepEqual(
      changedPostedInvoiceFields(stored, { customer: 'c1', date: '2026-09-01', status: 'SENT' }),
      [],
    )
  })

  it('reports only the fields whose submitted value differs', () => {
    assert.deepEqual(
      changedPostedInvoiceFields(stored, { customer: 'c1', amount: 250, status: 'SENT' }),
      ['amount'],
    )
  })

  it('ignores fields that were not submitted', () => {
    assert.deepEqual(changedPostedInvoiceFields(stored, { amount: undefined }), [])
  })

  it('treats numeric and string forms of the same value as equal', () => {
    assert.deepEqual(changedPostedInvoiceFields(stored, { amount: '200' }), [])
  })

  it('treats a null and an empty value as equal, but a real value as a change', () => {
    assert.deepEqual(changedPostedInvoiceFields({ x: null }, { x: '' }), [])
    assert.deepEqual(changedPostedInvoiceFields({ x: null }, { x: 'value' }), ['x'])
  })
})

describe('posted invoice line signature', () => {
  it('is identical for identical lines', () => {
    assert.equal(postedLineSignature([baseLine]), postedLineSignature([{ ...baseLine }]))
  })

  it('changes when any financial dimension or amount changes', () => {
    const original = postedLineSignature([baseLine])
    const changes: Array<Partial<PostedLineSignature>> = [
      { quantity: 3 },
      { unitPrice: 101 },
      { taxRate: 0 },
      { amount: 201 },
      { accountId: 'acct-B' },
      { projectId: 'proj-B' },
      { classId: 'class-B' },
      { locationId: 'loc-B' },
      { costCenterId: 'cc-1' },
    ]
    for (const change of changes) {
      assert.notEqual(postedLineSignature([{ ...baseLine, ...change }]), original, JSON.stringify(change))
    }
  })

  it('detects a changed second line', () => {
    const second = { ...baseLine, accountId: 'acct-B' }
    assert.notEqual(
      postedLineSignature([baseLine, second]),
      postedLineSignature([baseLine, baseLine]),
    )
  })
})

describe('posted invoice enforcement is on the server path', () => {
  const repo = readFileSync('src/lib/db/repositories/invoice.repository.supabase.ts', 'utf8').replace(/\r\n/g, '\n')
  const route = readFileSync('src/app/api/invoices/[id]/route.ts', 'utf8').replace(/\r\n/g, '\n')

  it('update rejects financial changes to posted invoices before any write', () => {
    const guardAt = repo.indexOf('changedPostedInvoiceFields(')
    const firstWriteAt = repo.indexOf(".from('invoice_lines')\n        .delete()")
    assert.ok(guardAt > 0 && firstWriteAt > guardAt, 'guard must run before line deletion')
    assert.match(repo, /if \(changed\.length > 0\) throw new Error\(POSTED_INVOICE_EDIT_ERROR\)/)
  })

  it('posted invoices never have their lines rewritten (keeps line-owned rows intact)', () => {
    assert.match(repo, /if \(rewriteLines && input\.lines !== undefined\)/)
  })

  it('delete rejects posted invoices', () => {
    assert.match(repo, /if \(isPostedInvoiceStatus\(existing\.status\)\) throw new Error\(POSTED_INVOICE_DELETE_ERROR\)/)
  })

  it('routes map both guard errors to 400', () => {
    assert.match(route, /error\.message === POSTED_INVOICE_EDIT_ERROR/)
    assert.match(route, /error\.message === POSTED_INVOICE_DELETE_ERROR/)
  })
})
