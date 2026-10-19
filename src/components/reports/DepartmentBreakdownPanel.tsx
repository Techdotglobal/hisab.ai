'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { DrillAmount, type DrilldownParams } from '@/components/reports/DrilldownDrawer'
import { useFormatCurrency } from '@/hooks/use-company-currency'
import { readApiError } from '@/lib/api-client'

interface Result {
  metric: { label: string }
  companyTotal: number
  departmentsTotal: number
  reconciliation: { difference: number; status: 'RECONCILED' | 'DIFFERENCE' }
  rows: Array<{ costCenterId: string | null; code: string | null; name: string; type: string | null; total: number; lines: number }>
}

const METRICS: Array<[string, string]> = [['pl.revenue', 'Revenue'], ['pl.expenses', 'Operating expenses'], ['pl.net_profit', 'Net profit']]

/** A P&L figure split by department; every bucket opens its own breakdown, and buckets reconcile to the company total. */
export function DepartmentBreakdownPanel({ from, to, onDrill }: { from: string; to: string; onDrill: (p: DrilldownParams) => void }) {
  const format = useFormatCurrency()
  const [metric, setMetric] = useState('pl.expenses')
  const [state, setState] = useState<{ key: string; result?: Result; error?: string }>({ key: '' })
  const key = `${metric}|${from}|${to}`

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await fetch(`/api/reports/by-department?${new URLSearchParams({ metric, from, to })}`)
      if (cancelled) return
      if (res.ok) setState({ key, result: await res.json() })
      else setState({ key, error: res.status === 403 ? 'You do not have permission to view the department breakdown.' : await readApiError(res) })
    })()
    return () => { cancelled = true }
  }, [metric, from, to, key])

  const cur = state.key === key ? state : null
  const r = cur?.result

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <h2 className="text-base font-semibold text-gray-800">By department / cost center</h2>
        <select value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="Figure to split" className="h-8 rounded-lg border border-gray-300 px-2 text-sm">
          {METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {!cur && <div className="skeleton m-5 h-24 rounded-lg" />}
      {cur?.error && <p className="p-5 text-sm text-red-600">{cur.error}</p>}
      {r && (
        <>
          <table className="w-full text-sm">
            <tbody>
              {r.rows.length === 0 && <tr><td className="px-5 py-6 text-center text-gray-400">No posted activity in this period.</td></tr>}
              {r.rows.map((row) => (
                <tr key={row.costCenterId ?? 'unassigned'} className="border-b">
                  <td className="px-5 py-2 text-gray-700">
                    {row.code ? `${row.code} ` : ''}{row.name}
                    {row.type && <span className="ml-2 text-[11px] uppercase text-gray-400">{row.type}</span>}
                    {!row.costCenterId && <span className="ml-2 text-[11px] text-amber-600">needs a department</span>}
                  </td>
                  <td className="px-2 py-2 text-right text-xs text-gray-400">{row.lines} lines</td>
                  <td className="px-5 py-2 text-right">
                    <DrillAmount label={row.name} onClick={() => onDrill({ metric, from, to, costCenterId: row.costCenterId ?? 'unassigned' })}>{format(row.total)}</DrillAmount>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 font-semibold">
                <td className="px-5 py-2.5">Departments total</td><td />
                <td className="px-5 py-2.5 text-right">{format(r.departmentsTotal)}</td>
              </tr>
              <tr>
                <td colSpan={3} className="px-5 py-2 text-xs">
                  {r.reconciliation.status === 'RECONCILED'
                    ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={13} /> Matches the company-level {r.metric.label.toLowerCase()} ({format(r.companyTotal)})</span>
                    : <span className="inline-flex items-center gap-1 text-red-700"><AlertTriangle size={13} /> Differs from the company-level figure by {format(r.reconciliation.difference)}</span>}
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  )
}
