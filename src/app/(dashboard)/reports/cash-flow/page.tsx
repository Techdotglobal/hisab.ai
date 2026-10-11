'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { ReportActions } from '@/components/data-tools/report-actions'
import type { ExportColumn } from '@/lib/export/table-export'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, LineChart, Line,
} from 'recharts'
import { ArrowDownLeft, ArrowUpRight, Activity, ArrowLeft } from 'lucide-react'

interface CashFlowData {
  period: { from: string; to: string }
  totalInflows: number
  totalOutflows: number
  netCashFlow: number
  monthly: { month: string; inflows: number; outflows: number; net: number }[]
}

function formatMonth(key: string) {
  const [year, month] = key.split('-')
  return new Date(Number(year), Number(month) - 1, 1).toLocaleString('en', { month: 'short', year: '2-digit' })
}

export default function CashFlowPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [from, setFrom] = useState(new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0])
  const [to, setTo] = useState(new Date().toISOString().split('T')[0])
  const [data, setData] = useState<CashFlowData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ from, to })
      const res = await fetch(`/api/reports/cash-flow?${params}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setError(err.error || 'Failed to load report')
        setData(null)
        return
      }
      setData(await res.json())
    } catch {
      setError('Could not connect to the server')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  const chartData = (data?.monthly ?? []).map((m) => ({
    ...m,
    label: formatMonth(m.month),
  }))

  type CfRow = CashFlowData['monthly'][number]
  const cfColumns: ExportColumn<CfRow>[] = [
    { header: 'Month', value: (m) => formatMonth(m.month) }, { header: `Inflows (${currency})`, value: (m) => m.inflows, type: 'currency' },
    { header: `Outflows (${currency})`, value: (m) => m.outflows, type: 'currency' }, { header: `Net (${currency})`, value: (m) => m.net, type: 'currency' },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <Link
        href="/reports"
        className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium mb-4"
      >
        <ArrowLeft size={14} />
        Back to reports
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Cash Flow Statement</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Cash receipts from customers and payments to vendors for the selected period
        </p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-6">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">From</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
                    <ReportActions loading={loading} onApply={load} onClear={() => { setFrom(new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]); setTo(new Date().toISOString().split('T')[0]); setData(null); setError('') }} applyLabel="Generate Report"
            exportRows={data?.monthly ?? null} exportColumns={cfColumns} filename="cash-flow" sheetName="Cash Flow"
            meta={['Cash Flow Statement', `Period: ${from} to ${to}`, data ? `Total inflows: ${data.totalInflows.toFixed(2)} / Total outflows: ${data.totalOutflows.toFixed(2)} / Net: ${data.netCashFlow.toFixed(2)}` : '', `Currency: ${currency}`]} />
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-emerald-50 rounded-xl border border-emerald-100 p-5">
              <div className="flex items-center gap-2 text-emerald-700 mb-2">
                <ArrowDownLeft size={18} />
                <p className="text-xs font-semibold uppercase tracking-wide">Cash inflows</p>
              </div>
              <p className="text-2xl font-bold text-emerald-700 tabular">{formatCurrency(data.totalInflows)}</p>
              <p className="text-xs text-emerald-600/80 mt-1">Customer invoice payments</p>
            </div>
            <div className="bg-rose-50 rounded-xl border border-rose-100 p-5">
              <div className="flex items-center gap-2 text-rose-700 mb-2">
                <ArrowUpRight size={18} />
                <p className="text-xs font-semibold uppercase tracking-wide">Cash outflows</p>
              </div>
              <p className="text-2xl font-bold text-rose-700 tabular">{formatCurrency(data.totalOutflows)}</p>
              <p className="text-xs text-rose-600/80 mt-1">Vendor bill payments</p>
            </div>
            <div className={`rounded-xl border p-5 ${data.netCashFlow >= 0 ? 'bg-indigo-50 border-indigo-100' : 'bg-orange-50 border-orange-100'}`}>
              <div className={`flex items-center gap-2 mb-2 ${data.netCashFlow >= 0 ? 'text-indigo-700' : 'text-orange-700'}`}>
                <Activity size={18} />
                <p className="text-xs font-semibold uppercase tracking-wide">Net cash flow</p>
              </div>
              <p className={`text-2xl font-bold tabular ${data.netCashFlow >= 0 ? 'text-indigo-700' : 'text-orange-700'}`}>
                {formatCurrency(data.netCashFlow)}
              </p>
              <p className={`text-xs mt-1 ${data.netCashFlow >= 0 ? 'text-indigo-600/80' : 'text-orange-600/80'}`}>
                Inflows minus outflows
              </p>
            </div>
          </div>

          {chartData.length > 0 && (
            <>
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h2 className="text-base font-semibold text-slate-900 mb-4">Monthly inflows vs outflows</h2>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Legend />
                    <Bar dataKey="inflows" name="Inflows" fill="#22c55e" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="outflows" name="Outflows" fill="#f43f5e" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h2 className="text-base font-semibold text-slate-900 mb-4">Net cash flow trend</h2>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Line
                      type="monotone"
                      dataKey="net"
                      name="Net cash flow"
                      stroke="#6366f1"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: '#6366f1' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b text-xs text-slate-500 uppercase">
                  <th className="px-5 py-3 text-left font-medium">Month</th>
                  <th className="px-5 py-3 text-right font-medium">Inflows</th>
                  <th className="px-5 py-3 text-right font-medium">Outflows</th>
                  <th className="px-5 py-3 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {chartData.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-10 text-center text-slate-400">
                      No payment activity in this period. Record invoice or bill payments to see cash flow.
                    </td>
                  </tr>
                ) : (
                  chartData.map((row) => (
                    <tr key={row.month} className="border-b hover:bg-slate-50">
                      <td className="px-5 py-2.5 font-medium text-slate-800">{row.label}</td>
                      <td className="px-5 py-2.5 text-right text-emerald-600 tabular">{formatCurrency(row.inflows)}</td>
                      <td className="px-5 py-2.5 text-right text-rose-600 tabular">{formatCurrency(row.outflows)}</td>
                      <td className={`px-5 py-2.5 text-right font-semibold tabular ${row.net >= 0 ? 'text-indigo-600' : 'text-orange-600'}`}>
                        {formatCurrency(row.net)}
                      </td>
                    </tr>
                  ))
                )}
                {chartData.length > 0 && (
                  <tr className="bg-slate-50 font-bold">
                    <td className="px-5 py-3 text-slate-900">Total</td>
                    <td className="px-5 py-3 text-right text-emerald-700 tabular">{formatCurrency(data.totalInflows)}</td>
                    <td className="px-5 py-3 text-right text-rose-700 tabular">{formatCurrency(data.totalOutflows)}</td>
                    <td className={`px-5 py-3 text-right tabular ${data.netCashFlow >= 0 ? 'text-indigo-700' : 'text-orange-700'}`}>
                      {formatCurrency(data.netCashFlow)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!data && !loading && !error && (
        <div className="flex items-center justify-center h-48 text-slate-400 text-sm rounded-xl border border-dashed border-slate-200">
          Select a date range and click &quot;Generate Report&quot;
        </div>
      )}
    </div>
  )
}
