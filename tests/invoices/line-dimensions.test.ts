import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { calculateInvoiceTotals } from '../../src/lib/invoices/calculations'
import { mapInvoiceLineRow } from '../../src/lib/db/entity-mappers'
import { processLines } from '../../src/lib/db/repositories/invoice.repository.supabase'

const lineOne = {
  description: 'Consulting',
  quantity: 2,
  unitPrice: 100,
  taxRate: 15,
  taxRateId: 'tax-15',
  accountId: 'acct-A',
  projectId: 'proj-A',
  classId: 'class-A',
  locationId: 'loc-A',
}

const lineTwo = {
  description: 'Hosting',
  quantity: 1,
  unitPrice: 50,
  taxRate: 15,
  taxRateId: 'tax-15',
  accountId: 'acct-B',
  projectId: 'proj-B',
  classId: 'class-B',
  locationId: 'loc-B',
}

describe('invoice line dimensions stay independent', () => {
  it('keeps account, project, class and location per line', () => {
    const { processedLines } = processLines([lineOne, lineTwo], 'TAX_EXCLUSIVE')
    assert.equal(processedLines[0].accountId, 'acct-A')
    assert.equal(processedLines[0].projectId, 'proj-A')
    assert.equal(processedLines[0].classId, 'class-A')
    assert.equal(processedLines[0].locationId, 'loc-A')
    assert.equal(processedLines[1].accountId, 'acct-B')
    assert.equal(processedLines[1].projectId, 'proj-B')
    assert.equal(processedLines[1].classId, 'class-B')
    assert.equal(processedLines[1].locationId, 'loc-B')
  })

  it('a line without a location carries null and does not borrow another line location', () => {
    const { processedLines } = processLines(
      [lineOne, { ...lineTwo, locationId: '' }],
      'TAX_EXCLUSIVE',
    )
    assert.equal(processedLines[0].locationId, 'loc-A')
    assert.equal(processedLines[1].locationId, null)
  })

  it('location does not change tax, subtotal or total', () => {
    const withLocation = processLines([lineOne, lineTwo], 'TAX_EXCLUSIVE')
    const withoutLocation = processLines(
      [{ ...lineOne, locationId: '' }, { ...lineTwo, locationId: '' }],
      'TAX_EXCLUSIVE',
    )
    const expected = calculateInvoiceTotals(
      [
        { quantity: 2, unitPrice: 100, taxRate: 15 },
        { quantity: 1, unitPrice: 50, taxRate: 15 },
      ],
      'TAX_EXCLUSIVE',
    )
    assert.equal(withLocation.subtotal, expected.subtotal)
    assert.equal(withLocation.taxAmount, expected.taxAmount)
    assert.equal(withLocation.total, expected.total)
    assert.equal(withLocation.total, withoutLocation.total)
  })

  it('maps location_id from the database row and tolerates legacy rows without it', () => {
    const row = mapInvoiceLineRow({
      id: 'line-1',
      invoice_id: 'inv-1',
      account_id: 'acct-A',
      project_id: 'proj-A',
      class_id: 'class-A',
      location_id: 'loc-A',
      cost_center_id: null,
      description: 'Consulting',
      quantity: 2,
      unit_price: 100,
      tax_rate: 15,
      amount: 200,
    })
    assert.equal(row.locationId, 'loc-A')
    assert.equal(row.accountId, 'acct-A')
    assert.equal(row.projectId, 'proj-A')
    assert.equal(row.classId, 'class-A')

    const legacy = mapInvoiceLineRow({ id: 'line-2', invoice_id: 'inv-1', description: 'Old', amount: 0 })
    assert.equal(legacy.locationId, null)
  })
})

describe('invoice line location save path', () => {
  const repoSource = readFileSync('src/lib/db/repositories/invoice.repository.supabase.ts', 'utf8')
  const formSource = readFileSync('src/components/invoices/invoice-create-form.tsx', 'utf8')
  const pageSource = readFileSync('src/app/(dashboard)/invoices/page.tsx', 'utf8')

  it('resolves location as a LOCATION cost center and writes location_id', () => {
    assert.match(repoSource, /resolveTypedCostCenter\(line\.locationId, 'LOCATION', companyId\)/)
    assert.match(repoSource, /\.\.\.\(location \? \{ location_id: location\.id \} : \{\}\)/)
  })

  it('never writes location into cost_center_id or any other dimension', () => {
    assert.match(repoSource, /cost_center_id: await resolveScopedUuid\('cost_centers', line\.costCenterId, companyId\)/)
    assert.doesNotMatch(repoSource, /cost_center_id:\s*location/)
    assert.doesNotMatch(repoSource, /project_id:\s*location/)
  })

  it('loads only LOCATION cost centers in the form', () => {
    assert.match(formSource, /\/api\/cost-centers\?type=LOCATION&activeOnly=true/)
  })

  it('renders a per-line location selector bound to that line only', () => {
    assert.match(formSource, /value=\{line\.locationId\}/)
    assert.match(formSource, /updateLine\(idx, \{ locationId: e\.target\.value \}\)/)
  })

  it('submits and restores locationId in the page payload and edit flow', () => {
    assert.match(pageSource, /locationId: line\.locationId \|\| null/)
    assert.match(pageSource, /locationId: line\.locationId \?\? ''/)
  })

  it('posting does not read location_id', () => {
    const posting = readFileSync('src/lib/accounting/document-posting.ts', 'utf8')
    assert.doesNotMatch(posting, /location_id|locationId/)
  })
})
