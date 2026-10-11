import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as XLSX from 'xlsx'
import { buildCsv, type ExportColumn } from '../../src/lib/export/table-export'
import { parseExportFormat, tableDownloadResponse } from '../../src/lib/export/serialize-table'
import { inDateRange } from '../../src/components/data-tools/filter-panel'

type Row = { name: string | null; date: string; amount: number }
const columns: ExportColumn<Row>[] = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Date', value: (r) => r.date, type: 'date' },
  { header: 'Amount', value: (r) => r.amount, type: 'currency' },
]

describe('buildCsv', () => {
  it('writes a BOM, CRLF rows, escaped quotes/commas and ISO dates', () => {
    const csv = buildCsv(columns, [{ name: 'Acme, "Inc"', date: '2026-03-04T10:00:00.000Z', amount: 1234.5 }])
    assert.equal(csv.charCodeAt(0), 0xfeff)
    const lines = csv.slice(1).split('\r\n')
    assert.equal(lines[0], 'Name,Date,Amount')
    assert.equal(lines[1], '"Acme, ""Inc""",2026-03-04,1234.50')
  })

  it('neutralises formula injection in text but keeps negative numbers numeric', () => {
    const csv = buildCsv(columns, [{ name: '=HYPERLINK("x")', date: '2026-01-01', amount: -50 }])
    const row = csv.slice(1).split('\r\n')[1]
    assert.ok(row.startsWith(`"'=HYPERLINK(""x"")"`), row)
    assert.ok(row.endsWith(',-50.00'), row)
  })

  it('emits every row, not a page', () => {
    const rows = Array.from({ length: 1234 }, (_, i) => ({ name: `n${i}`, date: '2026-01-01', amount: i }))
    const lines = buildCsv(columns, rows).trim().split('\r\n')
    assert.equal(lines.length, 1235)
  })
})

describe('tableDownloadResponse', () => {
  it('keeps numbers numeric in XLSX', async () => {
    const res = tableDownloadResponse('xlsx', 'demo', ['Name', 'Total'], [['A', 10.5], ['B', -3]], 'Demo')
    assert.match(res.headers.get('Content-Disposition') ?? '', /demo-\d{4}-\d{2}-\d{2}\.xlsx/)
    const wb = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
    const sheet = wb.Sheets.Demo
    assert.equal(sheet.B2.t, 'n')
    assert.equal(sheet.B2.v, 10.5)
    assert.equal(sheet.B3.v, -3)
  })

  it('builds CSV with BOM and defaults unknown formats to csv', async () => {
    assert.equal(parseExportFormat('pdf'), 'csv')
    assert.equal(parseExportFormat('xlsx'), 'xlsx')
    const res = tableDownloadResponse('csv', 'demo', ['A'], [['x,y']])
    const bytes = new Uint8Array(await res.arrayBuffer())
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])
    assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), '﻿A\r\n"x,y"\r\n')
  })
})

describe('inDateRange', () => {
  it('is inclusive and ignores unset bounds', () => {
    assert.equal(inDateRange('2026-02-10T23:00:00Z', '2026-02-10', '2026-02-10'), true)
    assert.equal(inDateRange('2026-02-09', '2026-02-10'), false)
    assert.equal(inDateRange('2026-02-11', undefined, '2026-02-10'), false)
    assert.equal(inDateRange(undefined, '2026-01-01'), false)
    assert.equal(inDateRange(undefined), true)
  })
})
