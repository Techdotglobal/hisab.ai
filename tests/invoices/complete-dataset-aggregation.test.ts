import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fetchAllRows } from '../../src/lib/db/repository-utils'

function fakeTable(rowCount: number) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({ id: String(i).padStart(6, '0'), total: 1 }))
  let rangeCalls = 0
  const factory = () => ({
    range(from: number, to: number) {
      rangeCalls++
      const data = rows.slice(from, to + 1)
      return Promise.resolve({ data, error: null })
    },
  })
  return { factory, rows, rangeCalls: () => rangeCalls }
}

describe('complete-dataset paging for invoice aggregations', () => {
  it('returns every row across the 1,000-row PostgREST page boundary', async () => {
    const table = fakeTable(2_503)
    const { data, error } = await fetchAllRows(table.factory)
    assert.equal(error, null)
    assert.equal(data.length, 2_503)
    assert.equal(new Set(data.map((r) => r.id)).size, 2_503)
  })

  it('a total that is an exact multiple of the page size is not truncated or over-read', async () => {
    const table = fakeTable(2_000)
    const { data } = await fetchAllRows(table.factory)
    assert.equal(data.length, 2_000)
    assert.equal(table.rangeCalls(), 3)
  })

  it('an empty result returns an empty array', async () => {
    const { data } = await fetchAllRows(fakeTable(0).factory)
    assert.deepEqual(data, [])
  })

  it('the three audited invoice aggregations page through fetchAllRows with a deterministic order', () => {
    const customerRepo = readFileSync('src/lib/db/repositories/customer.repository.supabase.ts', 'utf8').replace(/\r\n/g, '\n')
    const statement = readFileSync('src/lib/sales/customer-statement.ts', 'utf8').replace(/\r\n/g, '\n')
    const financial = readFileSync('src/lib/reporting/providers/financial-extended.ts', 'utf8').replace(/\r\n/g, '\n')

    assert.match(customerRepo, /fetchAllRows\(\(\) =>[\s\S]*from\('invoices'\)[\s\S]*order\('id'/)
    assert.match(statement, /fetchAllRows\(buildInvoiceQuery\)/)
    assert.match(statement, /fetchAllRows\(buildPaymentQuery\)/)
    assert.match(statement, /\.order\('id', \{ ascending: true \}\)/)
    assert.match(financial, /fetchAllRows\(buildInvoiceQuery\)/)
    assert.match(financial, /\.order\('date'\)\.order\('id'\)/)
  })

  it('sales list endpoints read complete result sets with deterministic ordering', () => {
    const files = [
      'src/app/api/sales-transactions/route.ts',
      'src/app/api/sales-receipts/route.ts',
      'src/app/api/estimates/route.ts',
      'src/app/api/sales-orders/route.ts',
    ]
    for (const file of files) {
      const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      assert.match(source, /fetchAllRows\(/, `${file} must page through fetchAllRows`)
      assert.match(source, /\.order\('id', \{ ascending: true \}\)/, `${file} needs an id tie-breaker`)
    }
  })

  it('payment lookups are chunked so the invoice-id filter cannot exceed URL limits', () => {
    const statement = readFileSync('src/lib/sales/customer-statement.ts', 'utf8').replace(/\r\n/g, '\n')
    assert.match(statement, /PAYMENT_LOOKUP_CHUNK = 100/)
    assert.match(statement, /\.in\('invoice_id', chunk\)/)
  })
})
