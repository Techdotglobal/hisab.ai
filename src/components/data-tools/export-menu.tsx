'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Download, FileSpreadsheet, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { exportTable, type ExportColumn, type ExportFormat } from '@/lib/export/table-export'

interface ExportMenuProps<T> {
  /** File name without extension. */
  filename: string
  columns: ExportColumn<T>[]
  /** The complete filtered + searched dataset (all pages), or a loader for it. */
  rows: T[] | (() => T[] | Promise<T[]>)
  sheetName?: string
  /** Lines describing applied filters; written above the table in XLSX. */
  meta?: string[]
  disabled?: boolean
  label?: string
}

type Status = { kind: 'success' | 'error'; message: string } | null

export function ExportMenu<T>({ filename, columns, rows, sheetName, meta, disabled, label = 'Export' }: ExportMenuProps<T>) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  function flash(next: Status) {
    setStatus(next)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setStatus(null), 5000)
  }

  async function run(format: ExportFormat) {
    setOpen(false)
    setBusy(format)
    setStatus(null)
    try {
      const data = typeof rows === 'function' ? await rows() : rows
      if (data.length === 0) {
        flash({ kind: 'error', message: 'Nothing to export for the current filters.' })
        return
      }
      const count = await exportTable({ format, filename, sheetName, columns, rows: data, meta })
      flash({ kind: 'success', message: `Exported ${count.toLocaleString()} row${count === 1 ? '' : 's'} as ${format.toUpperCase()}.` })
    } catch (error) {
      flash({ kind: 'error', message: error instanceof Error ? `Export failed: ${error.message}` : 'Export failed.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="relative flex items-center gap-2">
      <span role="status" aria-live="polite" className="sr-only">{status?.message ?? ''}</span>
      {status && (
        <span
          className={`hidden items-center gap-1 text-xs font-medium sm:inline-flex ${status.kind === 'success' ? 'text-emerald-600' : 'text-rose-600'}`}
        >
          {status.kind === 'success' ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
          {status.message}
        </span>
      )}
      <Button variant="outline" onClick={() => setOpen((v) => !v)} loading={busy !== null} disabled={disabled} aria-haspopup="menu" aria-expanded={open}>
        <Download size={14} />
        {busy ? 'Exporting…' : label}
        <ChevronDown size={14} />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-lg">
            <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50" onClick={() => void run('csv')}>
              <FileText size={14} /> Export as CSV (.csv)
            </button>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50" onClick={() => void run('xlsx')}>
              <FileSpreadsheet size={14} /> Export as Excel (.xlsx)
            </button>
          </div>
        </>
      )}
    </div>
  )
}
