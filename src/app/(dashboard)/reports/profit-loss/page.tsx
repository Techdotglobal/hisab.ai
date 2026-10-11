'use client'

import { useState } from 'react'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { ReportActions } from '@/components/data-tools/report-actions'
import type { ExportColumn } from '@/lib/export/table-export'

interface PLData {
  period: { from: string; to: string }
  revenue: { total: number; byAccount: { name: string; amount: number }[] }
  cogs: { total: number }
  grossProfit: number
  expenses: { total: number; byAccount: { name: string; amount: number }[] }
  netProfit: number
}

export default function ProfitLossPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [from, setFrom] = useState(new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0])
  const [to, setTo] = useState(new Date().toISOString().split('T')[0])
  const [data, setData] = useState<PLData | null>(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    const params = new URLSearchParams({ from, to })
    const res = await fetch(`/api/reports/profit-loss?${params}`)
    if (res.ok) setData(await res.json())
    setLoading(false)
  }

  type PlRow = { section: string; item: string; amount: number }
  const plRows: PlRow[] | null = data ? [
    ...data.revenue.byAccount.map((a) => ({ section: 'Income', item: a.name, amount: a.amount })),
    { section: 'Income', item: 'Total Revenue', amount: data.revenue.total },
    { section: 'Cost of Sales', item: 'Total Cost of Sales', amount: data.cogs.total },
    { section: 'Summary', item: 'Gross Profit', amount: data.grossProfit },
    ...data.expenses.byAccount.map((a) => ({ section: 'Operating Expenses', item: a.name, amount: a.amount })),
    { section: 'Operating Expenses', item: 'Total Expenses', amount: data.expenses.total },
    { section: 'Summary', item: 'Net Profit / (Loss)', amount: data.netProfit },
  ] : null
  const plColumns: ExportColumn<PlRow>[] = [
    { header: 'Section', value: (r) => r.section }, { header: 'Item', value: (r) => r.item }, { header: `Amount (${currency})`, value: (r) => r.amount, type: 'currency' },
  ]

  const chartData = data ? [
    { name: 'Revenue', value: data.revenue.total, fill: '#22c55e' },
    { name: 'COGS', value: data.cogs.total, fill: '#f97316' },
    { name: 'Expenses', value: data.expenses.total, fill: '#ef4444' },
    { name: 'Net Profit', value: data.netProfit, fill: data.netProfit >= 0 ? '#4f46e5' : '#dc2626' },
  ] : []

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Profit & Loss Statement</h1>
        <p className="text-gray-500 text-sm mt-0.5">Income statement for the selected period</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
                    <ReportActions loading={loading} onApply={load} onClear={() => { setFrom(new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]); setTo(new Date().toISOString().split('T')[0]); setData(null) }} applyLabel="Generate Report"
            exportRows={plRows} exportColumns={plColumns} filename="profit-and-loss" sheetName="Profit & Loss"
            meta={['Profit & Loss Statement', `Period: ${from} to ${to}`, `Currency: ${currency}`]} />
        </div>
      </div>

      {data && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Revenue', value: data.revenue.total, color: 'text-green-600', bg: 'bg-green-50' },
              { label: 'Cost of Sales', value: data.cogs.total, color: 'text-orange-600', bg: 'bg-orange-50' },
              { label: 'Total Expenses', value: data.expenses.total, color: 'text-red-600', bg: 'bg-red-50' },
              { label: 'Net Profit', value: data.netProfit, color: data.netProfit >= 0 ? 'text-indigo-600' : 'text-red-600', bg: data.netProfit >= 0 ? 'bg-indigo-50' : 'bg-red-50' },
            ].map((item) => (
              <div key={item.label} className={`${item.bg} rounded-xl p-4`}>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{item.label}</p>
                <p className={`text-xl font-bold mt-1 ${item.color}`}>{formatCurrency(item.value)}</p>
              </div>
            ))}
          </div>

          {/* Chart */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-base font-semibold text-gray-800 mb-4">P&L Overview</h2>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                <Bar dataKey="value" name="Amount" fill="#4f46e5" radius={[4, 4, 0, 0]}>
                  {chartData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Detailed Table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-xs text-gray-500 uppercase">
                  <th className="px-5 py-3 text-left font-medium">Item</th>
                  <th className="px-5 py-3 text-right font-medium">Amount ({currency})</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b bg-green-50">
                  <td className="px-5 py-2.5 font-semibold text-green-700 flex items-center gap-2">
                    <TrendingUp size={14} /> INCOME
                  </td>
                  <td />
                </tr>
                {data.revenue.byAccount.map((acc) => (
                  <tr key={acc.name} className="border-b">
                    <td className="px-5 py-2 pl-10 text-gray-600">{acc.name}</td>
                    <td className="px-5 py-2 text-right text-gray-800">{formatCurrency(acc.amount)}</td>
                  </tr>
                ))}
                <tr className="border-b bg-gray-50">
                  <td className="px-5 py-2.5 font-semibold text-gray-700 pl-10">Total Revenue</td>
                  <td className="px-5 py-2.5 text-right font-semibold text-green-600">{formatCurrency(data.revenue.total)}</td>
                </tr>
                <tr className="border-b">
                  <td className="px-5 py-2.5 font-semibold text-orange-700">COST OF SALES</td>
                  <td className="px-5 py-2.5 text-right font-semibold text-orange-600">({formatCurrency(data.cogs.total)})</td>
                </tr>
                <tr className="border-b bg-gray-50 font-bold">
                  <td className="px-5 py-3 text-gray-800">GROSS PROFIT</td>
                  <td className="px-5 py-3 text-right text-gray-900">{formatCurrency(data.grossProfit)}</td>
                </tr>
                <tr className="border-b bg-red-50">
                  <td className="px-5 py-2.5 font-semibold text-red-700 flex items-center gap-2">
                    <TrendingDown size={14} /> OPERATING EXPENSES
                  </td>
                  <td />
                </tr>
                {data.expenses.byAccount.map((item) => (
                  <tr key={item.name} className="border-b">
                    <td className="px-5 py-2 pl-10 text-gray-600">{item.name}</td>
                    <td className="px-5 py-2 text-right text-gray-800">({formatCurrency(item.amount)})</td>
                  </tr>
                ))}
                <tr className="border-b bg-gray-50">
                  <td className="px-5 py-2.5 font-semibold pl-10 text-gray-700">Total Expenses</td>
                  <td className="px-5 py-2.5 text-right font-semibold text-red-600">({formatCurrency(data.expenses.total)})</td>
                </tr>
                <tr className={`${data.netProfit >= 0 ? 'bg-indigo-50' : 'bg-red-50'} font-bold text-base`}>
                  <td className="px-5 py-4 text-gray-900">NET PROFIT / (LOSS)</td>
                  <td className={`px-5 py-4 text-right ${data.netProfit >= 0 ? 'text-indigo-600' : 'text-red-600'}`}>
                    {formatCurrency(data.netProfit)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!data && !loading && (
        <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
          Select a date range and click &quot;Generate Report&quot;
        </div>
      )}
    </div>
  )
}
