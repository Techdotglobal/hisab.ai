/**
 * Client-side tabular export (CSV + XLSX).
 *
 * Callers pass the *full filtered dataset* (not just the visible page) together
 * with column definitions, so exports always match the on-screen table.
 */

export type ExportFormat = 'csv' | 'xlsx'
export type ExportColumnType = 'text' | 'number' | 'currency' | 'date' | 'percent'

export interface ExportColumn<T> {
  header: string
  value: (row: T) => string | number | boolean | Date | null | undefined
  type?: ExportColumnType
  width?: number
}

export interface ExportOptions<T> {
  format: ExportFormat
  /** File name without extension; a date stamp is appended. */
  filename: string
  sheetName?: string
  columns: ExportColumn<T>[]
  rows: T[]
  /** Optional human-readable lines (filters, period) placed above the table in XLSX only. */
  meta?: string[]
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/

function safeText(value: string): string {
  // Neutralise spreadsheet formula injection in free-text cells only.
  return FORMULA_PREFIX.test(value) ? `'${value}` : value
}

function toIsoDate(value: unknown): string {
  if (value == null || value === '') return ''
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toISOString().slice(0, 10)
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function csvEscape(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvCell(value: unknown, type: ExportColumnType | undefined): string {
  if (value == null) return ''
  switch (type) {
    case 'date':
      return csvEscape(toIsoDate(value))
    case 'number':
    case 'percent':
    case 'currency': {
      const n = toNumber(value)
      return n == null ? csvEscape(safeText(String(value))) : type === 'currency' ? n.toFixed(2) : String(n)
    }
    default:
      return csvEscape(safeText(String(value)))
  }
}

export function buildCsv<T>(columns: ExportColumn<T>[], rows: T[]): string {
  const lines = [columns.map((c) => csvEscape(c.header)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value(row), c.type)).join(','))
  }
  // BOM so Excel detects UTF-8 (Arabic names etc.); CRLF per RFC 4180.
  return '﻿' + lines.join('\r\n') + '\r\n'
}

async function buildXlsx<T>(opts: ExportOptions<T>): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx')
  const { columns, rows, meta = [] } = opts
  const aoa: unknown[][] = []
  for (const line of meta) aoa.push([line])
  if (meta.length) aoa.push([])
  const headerRow = aoa.length
  aoa.push(columns.map((c) => c.header))
  for (const row of rows) {
    aoa.push(
      columns.map((c) => {
        const v = c.value(row)
        if (v == null) return ''
        if (c.type === 'date') {
          const iso = toIsoDate(v)
          return iso ? new Date(`${iso}T00:00:00Z`) : ''
        }
        if (c.type === 'number' || c.type === 'currency' || c.type === 'percent') {
          const n = toNumber(v)
          if (n != null) return n
        }
        if (typeof v === 'boolean') return v ? 'Yes' : 'No'
        return typeof v === 'string' ? safeText(v) : (v as number | Date)
      }),
    )
  }
  const sheet = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true })
  columns.forEach((c, colIndex) => {
    const fmt = c.type === 'currency' ? '#,##0.00' : c.type === 'date' ? 'yyyy-mm-dd' : c.type === 'percent' ? '0.00' : null
    if (!fmt) return
    for (let r = headerRow + 1; r < aoa.length; r++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: colIndex })]
      if (cell && (cell.t === 'n' || cell.t === 'd')) cell.z = fmt
    }
  })
  sheet['!cols'] = columns.map((c) => ({ wch: c.width ?? Math.max(12, Math.min(40, c.header.length + 4)) }))
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, (opts.sheetName ?? opts.filename).replace(/[\/?*[\]:]/g, ' ').slice(0, 31) || 'Export')
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Builds the file and triggers the browser download. Resolves with the exported row count. */
export async function exportTable<T>(opts: ExportOptions<T>): Promise<number> {
  const stamp = new Date().toISOString().slice(0, 10)
  const name = `${opts.filename.replace(/[^\w.-]+/g, '_')}-${stamp}.${opts.format}`
  if (opts.format === 'csv') {
    triggerDownload(new Blob([buildCsv(opts.columns, opts.rows)], { type: 'text/csv;charset=utf-8' }), name)
  } else {
    const buffer = await buildXlsx(opts)
    triggerDownload(
      new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      name,
    )
  }
  return opts.rows.length
}
