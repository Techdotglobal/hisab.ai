'use client'

import { useMemo, useState } from 'react'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { formatDate } from '@/lib/utils'
import { ReportActions } from '@/components/data-tools/report-actions'
import type { ExportColumn } from '@/lib/export/table-export'
import { FilterPanel, type FilterValues } from '@/components/data-tools/filter-panel'

interface AgedReport {
  asOf: string
  buckets: Record<string, { total: number; count: number }>
  grandTotal: number
  details: Array<{
    id: string; billNo: string; vendor?: { name: string }
    dueDate: string; balance: number; daysPastDue: number; bucket: string
  }>
}

export default function AgedApPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [filters, setFilters] = useState<FilterValues>({ party: '', bucket: '', minBalance: '' })
  const [asOf, setAsOf] = useState(new Date().toISOString().split('T')[0])
  const [data, setData] = useState<AgedReport | null>(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    const res = await fetch(`/api/reports/aged-ap?asOf=${asOf}`)
    if (res.ok) setData(await res.json())
    setLoading(false)
  }

  type Detail = AgedReport['details'][number]
  const visibleDetails = useMemo(() => (data?.details ?? []).filter((d) => {
    if (filters.party && !(d.vendor?.name ?? '').toLowerCase().includes(filters.party.toLowerCase())) return false
    if (filters.bucket && d.bucket !== filters.bucket) return false
    if (filters.minBalance !== '' && d.balance < Number(filters.minBalance)) return false
    return true
  }), [data, filters])
  const agedColumns: ExportColumn<Detail>[] = [
    { header: 'Bill No', value: (d) => d.billNo }, { header: 'Vendor', value: (d) => d.vendor?.name }, { header: 'Due Date', value: (d) => d.dueDate, type: 'date' },
    { header: 'Days Past Due', value: (d) => d.daysPastDue, type: 'number' }, { header: 'Bucket', value: (d) => d.bucket }, { header: `Balance (${currency})`, value: (d) => d.balance, type: 'currency' },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Aged Accounts Payable</h1>
        <p className="text-slate-500 text-sm mt-0.5">Outstanding vendor bills by aging bucket</p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">As of</label>
          <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} className="input-base" />
        </div>
                <ReportActions loading={loading} onApply={load} onClear={() => { setAsOf(new Date().toISOString().split('T')[0]); setFilters({ party: '', bucket: '', minBalance: '' }); setData(null) }} applyLabel="Generate"
          exportRows={data ? visibleDetails : null} exportColumns={agedColumns} filename="aged-ap" sheetName="Aged Payables"
          meta={['Aged Accounts Payable', `As of: ${asOf}`, ...Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`)]} />
      </div>

      {data && (
        <>
          <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'party', label: 'Vendor name', type: 'text' }, { key: 'bucket', label: 'Aging bucket', type: 'select', allLabel: 'All buckets', options: Object.keys(data.buckets).map((k) => ({ value: k, label: k })) }, { key: 'minBalance', label: 'Min balance', type: 'number' }]} />
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Object.entries(data.buckets).map(([bucket, agg]) => (
              <div key={bucket} className="bg-white rounded-xl border border-slate-200 p-4">
                <p className="text-xs text-slate-500 uppercase">{bucket}</p>
                <p className="text-lg font-bold text-slate-900 tabular">{formatCurrency(agg.total)}</p>
                <p className="text-xs text-slate-400">{agg.count} bills</p>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex justify-between">
              <span className="font-semibold text-slate-800">Detail</span>
              <span className="font-bold text-indigo-600 tabular">{formatCurrency(data.grandTotal)}</span>
            </div>
            <table className="w-full data-table">
              <thead>
                <tr className="border-b border-slate-100">
                  {['Bill', 'Vendor', 'Due', 'Days', 'Bucket', 'Balance'].map(h => (
                    <th key={h} className="px-4 py-2 text-left text-[11px] font-semibold text-slate-400 uppercase">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {visibleDetails.map(row => (
                  <tr key={row.id}>
                    <td className="px-4 py-2 text-xs font-mono text-indigo-600">{row.billNo}</td>
                    <td className="px-4 py-2 text-sm">{row.vendor?.name ?? '—'}</td>
                    <td className="px-4 py-2 text-xs">{formatDate(row.dueDate)}</td>
                    <td className="px-4 py-2 text-xs tabular">{row.daysPastDue}</td>
                    <td className="px-4 py-2 text-xs">{row.bucket}</td>
                    <td className="px-4 py-2 text-sm font-semibold text-right tabular">{formatCurrency(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
