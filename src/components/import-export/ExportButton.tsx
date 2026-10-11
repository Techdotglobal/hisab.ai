'use client'

import { useState } from 'react'
import { readApiError } from '@/lib/api-client'
import { Download, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ExportButtonProps {
  moduleKey: string
  filters?: Record<string, string>
  label?: string
  /** 'templates' hides the data-export items (used when the page supplies its own filtered export). */
  mode?: 'all' | 'templates'
}

export function ExportButton({ moduleKey, filters = {}, label, mode = 'all' }: ExportButtonProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const buttonLabel = label ?? (mode === 'templates' ? 'Templates' : 'Export')

  async function download(url: string, filename: string) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(await readApiError(response))
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    anchor.click()
    URL.revokeObjectURL(objectUrl)
  }

  async function handleAction(action: string) {
    setLoading(action)
    setOpen(false)
    setError(null)
    try {
      if (action === 'data-csv') {
        const params = new URLSearchParams({ format: 'csv', ...filters })
        await download(`/api/import-export/${moduleKey}/export?${params}`, `${moduleKey}-export.csv`)
      } else if (action === 'data-xlsx') {
        const params = new URLSearchParams({ format: 'xlsx', ...filters })
        await download(`/api/import-export/${moduleKey}/export?${params}`, `${moduleKey}-export.xlsx`)
      } else if (action === 'template-csv') {
        await download(
          `/api/import-export/${moduleKey}/template?format=csv`,
          `${moduleKey}-template.csv`,
        )
      } else if (action === 'template-xlsx') {
        await download(
          `/api/import-export/${moduleKey}/template?format=xlsx`,
          `${moduleKey}-template.xlsx`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed'
      setError(message)
      window.setTimeout(() => setError(null), 6000)
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="relative">
      <Button
        variant="outline"
        onClick={() => setOpen((value) => !value)}
        loading={loading !== null}
      >
        <Download size={15} />
        {loading ? 'Downloading…' : buttonLabel}
        <ChevronDown size={14} />
      </Button>
      {error && <p role="alert" className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 z-50 w-52 bg-white border border-slate-200 rounded-xl shadow-lg py-1">
            {mode === 'all' && (
              <>
                <button
                  className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50"
                  onClick={() => void handleAction('data-csv')}
                >
                  Export as CSV (.csv)
                </button>
                <button
                  className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50"
                  onClick={() => void handleAction('data-xlsx')}
                >
                  Export as Excel (.xlsx)
                </button>
                <div className="my-1 border-t border-slate-100" />
              </>
            )}
            <button
              className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50"
              onClick={() => void handleAction('template-csv')}
            >
              Download CSV Template
            </button>
            <button
              className="w-full text-left px-4 py-2 text-sm hover:bg-slate-50"
              onClick={() => void handleAction('template-xlsx')}
            >
              Download Excel Template
            </button>
          </div>
        </>
      )}
    </div>
  )
}
