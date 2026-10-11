'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Download, FileSpreadsheet, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { readApiError } from '@/lib/api-client'

interface ServerExportMenuProps {
  /** Export endpoint accepting `format=csv|xlsx` plus the same filter params as the list endpoint. */
  endpoint: string
  /** Applied filters + search, so the export matches the table. */
  params: URLSearchParams | Record<string, string>
  fallbackFilename: string
  disabled?: boolean
  label?: string
}

type Status = { kind: 'success' | 'error'; message: string } | null

/** Export menu for datasets produced server-side (permission-checked, complete filtered dataset). */
export function ServerExportMenu({ endpoint, params, fallbackFilename, disabled, label = 'Export' }: ServerExportMenuProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  function flash(next: Status) {
    setStatus(next)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setStatus(null), 5000)
  }

  async function run(format: 'csv' | 'xlsx') {
    setOpen(false)
    setBusy(true)
    setStatus(null)
    try {
      const query = new URLSearchParams(params)
      query.set('format', format)
      query.delete('page')
      query.delete('limit')
      const res = await fetch(`${endpoint}?${query}`)
      if (!res.ok) throw new Error(await readApiError(res))
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `${fallbackFilename}.${format}`
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      flash({ kind: 'success', message: `Exported as ${format.toUpperCase()}.` })
    } catch (error) {
      flash({ kind: 'error', message: error instanceof Error ? `Export failed: ${error.message}` : 'Export failed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex items-center gap-2">
      <span role="status" aria-live="polite" className="sr-only">{status?.message ?? ''}</span>
      {status && (
        <span className={`hidden items-center gap-1 text-xs font-medium sm:inline-flex ${status.kind === 'success' ? 'text-emerald-600' : 'text-rose-600'}`}>
          {status.kind === 'success' ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
          {status.message}
        </span>
      )}
      <Button variant="outline" onClick={() => setOpen((v) => !v)} loading={busy} disabled={disabled} aria-haspopup="menu" aria-expanded={open}>
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
