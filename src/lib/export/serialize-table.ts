import * as XLSX from 'xlsx'

export type TableCell = unknown

function normalise(value: unknown): string | number | boolean | Date | null {
  if (value == null) return null
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}
export type ServerExportFormat = 'csv' | 'xlsx'

const FORMULA_PREFIX = /^[=+\-@\t\r]/

function safeText(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value
}

function csvEscape(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvValue(raw: TableCell): string {
  const value = normalise(raw)
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return csvEscape(safeText(value))
}

export function parseExportFormat(value: string | null): ServerExportFormat {
  return value === 'xlsx' ? 'xlsx' : 'csv'
}

/**
 * Builds a downloadable CSV (UTF-8 with BOM, CRLF) or XLSX Response from a header row and data rows.
 * Numbers stay numeric in XLSX so spreadsheets can sum/sort them.
 */
export function tableDownloadResponse(
  format: ServerExportFormat,
  baseName: string,
  headers: string[],
  rows: TableCell[][],
  sheetName = 'Export',
): Response {
  const stamp = new Date().toISOString().slice(0, 10)
  const filename = `${baseName}-${stamp}.${format}`
  const common = { 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="${filename}"` }

  if (format === 'csv') {
    const body = [headers.map((h) => csvEscape(h)).join(','), ...rows.map((r) => r.map(csvValue).join(','))].join('\r\n')
    return new Response(`\uFEFF${body}\r\n`, { headers: { ...common, 'Content-Type': 'text/csv; charset=utf-8' } })
  }

  const aoa = [
    headers,
    ...rows.map((r) => r.map((raw) => { const v = normalise(raw); return v == null ? '' : typeof v === 'string' ? safeText(v) : v })),
  ]
  const sheet = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true })
  sheet['!cols'] = headers.map((h) => ({ wch: Math.max(12, Math.min(40, h.length + 4)) }))
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Export')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return new Response(new Uint8Array(buffer), {
    headers: { ...common, 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  })
}
