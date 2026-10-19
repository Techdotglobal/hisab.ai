'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { readApiError } from '@/lib/api-client'
import { formatDate } from '@/lib/utils'

interface Row {
  id: string; createdAt: string; actorName: string | null; actorId: string | null; action: string
  entityType: string; entityId: string | null; reason: string | null; before: unknown; after: unknown; href: string | null
}

const PAGE = 50

export default function AuditLogPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loadedFor, setLoadedFor] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const [canExport, setCanExport] = useState(false)
  const [filters, setFilters] = useState({ from: '', to: '', userId: '', action: '', entityType: '', entityId: '', category: '' })

  const qs = useCallback((extra: Record<string, string> = {}) => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v) sp.set(k, v)
    return sp.toString()
  }, [filters])

  const requestKey = JSON.stringify([filters, offset])
  const loading = loadedFor !== requestKey
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const from = filters.from ? new Date(filters.from).toISOString() : ''
      const to = filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : ''
      const res = await fetch(`/api/audit-logs?${qs({ from, to, limit: String(PAGE), offset: String(offset) })}`)
      if (cancelled) return
      if (res.status === 403) setDenied(true)
      else if (!res.ok) setError(await readApiError(res))
      else {
        const data = await res.json()
        setError(null); setRows(data.rows); setTotal(data.total)
      }
      setLoadedFor(requestKey)
    })()
    return () => { cancelled = true }
  }, [filters, offset, qs, requestKey])
  useEffect(() => {
    fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then((me) => setCanExport(Boolean(me?.permissions?.includes('audit_logs.export')))).catch(() => null)
  }, [])

  const set = (k: keyof typeof filters, v: string) => { setOffset(0); setFilters((f) => ({ ...f, [k]: v })) }

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Audit Log"
        subtitle={denied ? undefined : `${total} events`}
        breadcrumb={[{ label: 'Administration' }, { label: 'Audit Log' }]}
        action={canExport && !denied ? (
          <a href={`/api/audit-logs?${qs({ format: 'csv' })}`}><Button variant="outline"><Download size={15} /> Export CSV</Button></a>
        ) : undefined}
      />

      {denied ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">You do not have permission to view the audit log.</div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="flex flex-col gap-1 text-xs text-slate-500">From<input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} className="h-9 rounded-lg border border-slate-200 px-2" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">To<input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} className="h-9 rounded-lg border border-slate-200 px-2" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Category
              <select value={filters.category} onChange={(e) => set('category', e.target.value)} className="h-9 rounded-lg border border-slate-200 px-2">
                <option value="">All</option><option value="permissions">Permission changes</option><option value="financial">Financial changes</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Action<input value={filters.action} onChange={(e) => set('action', e.target.value.toUpperCase())} placeholder="e.g. PERMISSION_GRANTED" className="h-9 w-56 rounded-lg border border-slate-200 px-2" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Entity type<input value={filters.entityType} onChange={(e) => set('entityType', e.target.value)} placeholder="e.g. journal_entry" className="h-9 w-44 rounded-lg border border-slate-200 px-2" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">Record ID<input value={filters.entityId} onChange={(e) => set('entityId', e.target.value)} className="h-9 w-72 rounded-lg border border-slate-200 px-2" /></label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">User ID<input value={filters.userId} onChange={(e) => set('userId', e.target.value)} className="h-9 w-72 rounded-lg border border-slate-200 px-2" /></label>
          </div>

          {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-100 text-[11px] uppercase tracking-wider text-slate-400">
                {['When', 'Actor', 'Action', 'Record', 'Details'].map((h) => <th key={h} className="px-4 py-3 text-left">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? <tr><td colSpan={5} className="px-4 py-8"><div className="skeleton h-4 rounded" /></td></tr>
                  : rows.length === 0 ? <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-400">No audit events match these filters.</td></tr>
                  : rows.map((r) => (
                    <tr key={r.id} className="align-top">
                      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{formatDate(r.createdAt)} {new Date(r.createdAt).toLocaleTimeString()}</td>
                      <td className="px-4 py-3">{r.actorName || (r.actorId ? r.actorId.slice(0, 8) : 'System')}</td>
                      <td className="px-4 py-3 font-medium text-slate-800">{r.action.replace(/_/g, ' ').toLowerCase()}</td>
                      <td className="px-4 py-3 text-xs">
                        <div className="text-slate-500">{r.entityType}</div>
                        {r.entityId && (r.href ? <Link href={r.href} className="text-indigo-600 underline">{r.entityId.slice(0, 8)}…</Link> : <span className="text-slate-400">{r.entityId.slice(0, 8)}…</span>)}
                      </td>
                      <td className="px-4 py-3 text-[11px] text-slate-500">
                        {r.reason && <div>“{r.reason}”</div>}
                        {(r.before || r.after) ? <pre className="whitespace-pre-wrap">{JSON.stringify({ before: r.before ?? undefined, after: r.after ?? undefined })}</pre> : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
              <Button size="sm" variant="outline" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
