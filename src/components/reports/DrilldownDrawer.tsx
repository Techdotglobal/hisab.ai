'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Lock } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { readApiError } from '@/lib/api-client'
import { cn } from '@/lib/utils'

export interface DrilldownParams {
  metric: string
  accountId?: string
  from?: string
  to?: string
  asOf?: string
  costCenterId?: string
}

interface Row {
  ledgerEntryId: string; date: string; postingDate: string; reference: string | null; description: string | null
  sourceType: string; origin: string; sourceStatus: string | null; counterparty: string | null; department: string | null
  accountNo: string; accountName: string; debit: number; credit: number; subtotal: number | null; tax: number | null
  total: number | null; amountIncluded: number; journalNo: string | null; href: string | null
}
interface Result {
  metric: { label: string; kind: string }
  period: { from: string | null; to: string | null; asOf: string | null }
  filters: { costCenter: string | null; account: string | null; scopeRestricted: boolean }
  currency: string
  reportTotal: number
  includedTotal: number
  includedCount: number
  excluded: { drafts: number; missingSource: number }
  reconciliation: { difference: number; status: 'RECONCILED' | 'DIFFERENCE' }
  explanation: { summary: string; steps: string[]; arithmetic: string; limitations: string[] }
  rows: Row[] | null
  detailRestricted: boolean
  pagination: { total: number; limit: number; offset: number }
}

const money = (n: number | null, _unused?: string) =>
  n === null ? '—' : `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** A figure that opens its own breakdown. Render only where a genuine breakdown exists. */
export function DrillAmount({ children, onClick, label, className }: { children: React.ReactNode; onClick: () => void; label: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={`Show breakdown: ${label}`} title="Show how this was calculated"
      className={cn('underline decoration-dotted underline-offset-4 hover:text-indigo-700 hover:decoration-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 rounded', className)}>
      {children}
    </button>
  )
}

export function DrilldownDrawer({ params, onClose }: { params: DrilldownParams | null; onClose: () => void }) {
  const key = params ? JSON.stringify(params) : ''
  const [state, setState] = useState<{ key: string; result?: Result; error?: string; forbidden?: boolean }>({ key: '' })
  const [showHow, setShowHow] = useState(true)
  const [offset, setOffset] = useState(0)
  const [offsetKey, setOffsetKey] = useState(key)
  // Reset paging when the figure changes (derived, not an effect).
  if (offsetKey !== key) { setOffsetKey(key); setOffset(0) }

  useEffect(() => {
    if (!params) return
    let cancelled = false
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v)
    sp.set('offset', String(offset))
    void (async () => {
      const res = await fetch(`/api/reports/drilldown?${sp}`)
      if (cancelled) return
      if (res.status === 403) setState({ key, forbidden: true })
      else if (!res.ok) setState({ key, error: await readApiError(res) })
      else setState({ key, result: await res.json() })
    })()
    return () => { cancelled = true }
  }, [params, key, offset])

  const current = state.key === key ? state : { key: '' }
  const r = 'result' in current ? current.result : undefined
  const pageSize = r?.pagination.limit ?? 200

  return (
    <Modal open={Boolean(params)} onClose={onClose} size="3xl" title={r?.metric.label ?? 'Breakdown'}
      subtitle={r ? periodText(r) : undefined}>
      {!r && !('error' in current && current.error) && !('forbidden' in current && current.forbidden) && <div className="skeleton h-48 rounded-xl" />}
      {'forbidden' in current && current.forbidden && <p className="text-sm text-amber-700">You do not have permission to view this breakdown.</p>}
      {'error' in current && current.error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{current.error}</p>}
      {r && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Figure in report" value={`${r.currency} ${money(r.reportTotal, '')}`} />
            <Stat label="Contributing lines" value={String(r.includedCount)} />
            <Stat label="Excluded drafts" value={String(r.excluded.drafts)} hint="Not posted, so not in the ledger" />
            <div className={cn('rounded-xl border p-3', r.reconciliation.status === 'RECONCILED' ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50')}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Reconciliation</p>
              <p className={cn('mt-1 flex items-center gap-1.5 text-sm font-semibold', r.reconciliation.status === 'RECONCILED' ? 'text-emerald-700' : 'text-red-700')}>
                {r.reconciliation.status === 'RECONCILED' ? <><CheckCircle2 size={15} /> Lines add up to the report</> : <><AlertTriangle size={15} /> Difference {money(r.reconciliation.difference, '')}</>}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200">
            <button type="button" onClick={() => setShowHow(!showHow)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-slate-800">
              {showHow ? <ChevronDown size={15} /> : <ChevronRight size={15} />} How was this calculated?
            </button>
            {showHow && (
              <div className="space-y-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
                <p className="font-semibold text-slate-800">{r.explanation.summary}</p>
                <ol className="list-decimal space-y-1 pl-5">{r.explanation.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                <p className="rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-800">{r.explanation.arithmetic}</p>
                {r.explanation.limitations.length > 0 && (
                  <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                    {r.explanation.limitations.map((l) => <li key={l}>⚠ {l}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>

          {r.filters.scopeRestricted && (
            <p className="flex items-center gap-1.5 text-xs text-slate-500"><Lock size={12} /> Your access is limited to specific cost centers, so only those lines are listed.</p>
          )}

          {r.detailRestricted || !r.rows ? (
            <p className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
              <Lock size={14} /> You can see this total but not the underlying transactions. Ask the owner for &ldquo;View general ledger&rdquo; access.
            </p>
          ) : r.rows.length === 0 ? (
            <p className="text-sm text-slate-400">No posted transactions contribute to this figure.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[1200px] text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
                  <tr>
                    {['Date', 'Reference', 'Description', 'Source', 'Counterparty', 'Department', 'GL account', 'Debit', 'Credit', 'Subtotal', 'Tax', 'Total', 'Amount included', 'Status'].map((h, i) => (
                      <th key={h} className={cn('px-3 py-2 text-left', i >= 7 && i <= 12 && 'text-right')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {r.rows.map((row) => (
                    <tr key={row.ledgerEntryId} className="align-top">
                      <td className="whitespace-nowrap px-3 py-2">{row.date.slice(0, 10)}<div className="text-[10px] text-slate-400">posted {row.postingDate.slice(0, 10)}</div></td>
                      <td className="px-3 py-2">
                        {row.href ? <Link href={row.href} className="font-medium text-indigo-600 underline">{row.reference ?? row.origin}</Link> : <span className="font-medium">{row.reference ?? '—'}</span>}
                        {row.journalNo && <div className="text-[10px] text-slate-400">Journal {row.journalNo}</div>}
                      </td>
                      <td className="max-w-[220px] px-3 py-2">{row.description || '—'}</td>
                      <td className="px-3 py-2"><div>{row.sourceType.replace(/_/g, ' ').toLowerCase()}</div><div className="text-[10px] text-slate-400">{row.origin}</div></td>
                      <td className="px-3 py-2">{row.counterparty ?? <span className="text-slate-400">Not applicable</span>}</td>
                      <td className="px-3 py-2">{row.department ?? <span className="text-slate-400">Not assigned</span>}</td>
                      <td className="px-3 py-2">{row.accountNo} {row.accountName}</td>
                      <td className="px-3 py-2 text-right">{row.debit ? money(row.debit, '') : '—'}</td>
                      <td className="px-3 py-2 text-right">{row.credit ? money(row.credit, '') : '—'}</td>
                      <td className="px-3 py-2 text-right">{money(row.subtotal, '')}</td>
                      <td className="px-3 py-2 text-right">{money(row.tax, '')}</td>
                      <td className="px-3 py-2 text-right">{money(row.total, '')}</td>
                      <td className="px-3 py-2 text-right font-semibold">{money(row.amountIncluded, '')}</td>
                      <td className="px-3 py-2">{row.sourceStatus ?? <span className="text-slate-400">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="border-t border-slate-200 bg-slate-50 font-semibold">
                  <td colSpan={12} className="px-3 py-2 text-right">Total of all {r.includedCount} lines</td>
                  <td className="px-3 py-2 text-right">{money(r.includedTotal, '')}</td><td />
                </tr></tfoot>
              </table>
            </div>
          )}

          {r.rows && r.pagination.total > pageSize && (
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>{offset + 1}–{Math.min(offset + pageSize, r.pagination.total)} of {r.pagination.total}</span>
              <div className="flex gap-2">
                <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</button>
                <button className="rounded border px-2 py-1 disabled:opacity-40" disabled={offset + pageSize >= r.pagination.total} onClick={() => setOffset(offset + pageSize)}>Next</button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3" title={hint}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  )
}

function periodText(r: Result): string {
  const parts: string[] = []
  if (r.metric.kind === 'asof') parts.push(`As of ${(r.period.to ?? r.period.asOf ?? '').slice(0, 10)}`)
  else parts.push(`${(r.period.from ?? '').slice(0, 10) || 'start'} to ${(r.period.to ?? '').slice(0, 10) || 'today'}`)
  if (r.filters.costCenter) parts.push(`Department: ${r.filters.costCenter}`)
  parts.push('Posted transactions only')
  return parts.join(' · ')
}
