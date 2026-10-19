'use client'

import { useState } from 'react'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { DrilldownDrawer, DrillAmount, type DrilldownParams } from '@/components/reports/DrilldownDrawer'
import { ReportActions } from '@/components/data-tools/report-actions'
import type { ExportColumn } from '@/lib/export/table-export'

interface TBRow {
  accountId?: string
  accountNo: string
  accountName: string
  canonicalType: string
  debit: number
  credit: number
  balance: number
}

interface TBData {
  asOf: string
  rows: TBRow[]
  totalDebit: number
  totalCredit: number
  isBalanced: boolean
}

export default function TrialBalancePage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [asOf, setAsOf] = useState(new Date().toISOString().split('T')[0])
  const [data, setData] = useState<TBData | null>(null)
  const [loading, setLoading] = useState(false)
  const [drill, setDrill] = useState<DrilldownParams | null>(null)

  async function load() {
    setLoading(true)
    const res = await fetch(`/api/reports/trial-balance?asOf=${asOf}`)
    if (res.ok) setData(await res.json())
    setLoading(false)
  }

  const tbColumns: ExportColumn<TBRow>[] = [
    { header: 'Account No', value: (r) => r.accountNo }, { header: 'Account', value: (r) => r.accountName }, { header: 'Type', value: (r) => r.canonicalType },
    { header: `Debit (${currency})`, value: (r) => r.debit, type: 'currency' }, { header: `Credit (${currency})`, value: (r) => r.credit, type: 'currency' }, { header: `Balance (${currency})`, value: (r) => r.balance, type: 'currency' },
  ]

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Trial Balance</h1>
        <p className="text-gray-500 text-sm mt-0.5">Debit and credit totals for all accounts from the general ledger</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">As of Date</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
                    <ReportActions loading={loading} onApply={load} onClear={() => { setAsOf(new Date().toISOString().split('T')[0]); setData(null) }} applyLabel="Generate"
            exportRows={data?.rows ?? null} exportColumns={tbColumns} filename="trial-balance" sheetName="Trial Balance"
            meta={['Trial Balance', `As of: ${asOf}`, `Currency: ${currency}`, data ? `Total debit: ${data.totalDebit.toFixed(2)} / Total credit: ${data.totalCredit.toFixed(2)}` : '']} />
        </div>
      </div>

      {data && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className={`px-5 py-3 border-b text-sm font-medium ${data.isBalanced ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {data.isBalanced ? 'Trial balance is balanced' : 'Trial balance is out of balance'}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-5 py-3 font-semibold text-gray-600">Account No.</th>
                <th className="text-left px-5 py-3 font-semibold text-gray-600">Account Name</th>
                <th className="text-left px-5 py-3 font-semibold text-gray-600">Type</th>
                <th className="text-right px-5 py-3 font-semibold text-gray-600">Debit</th>
                <th className="text-right px-5 py-3 font-semibold text-gray-600">Credit</th>
                <th className="text-right px-5 py-3 font-semibold text-gray-600">Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.accountNo} className="border-b hover:bg-gray-50">
                  <td className="px-5 py-2.5 text-gray-500">{row.accountNo}</td>
                  <td className="px-5 py-2.5 text-gray-800">{row.accountName}</td>
                  <td className="px-5 py-2.5 text-gray-500">{row.canonicalType}</td>
                  <td className="px-5 py-2.5 text-right">{formatCurrency(row.debit)}</td>
                  <td className="px-5 py-2.5 text-right">{formatCurrency(row.credit)}</td>
                  <td className="px-5 py-2.5 text-right font-medium">{row.accountId ? <DrillAmount label={`${row.accountNo} ${row.accountName}`} onClick={() => setDrill({ metric: 'account', accountId: row.accountId, asOf: data.asOf.slice(0, 10) })}>{formatCurrency(row.balance)}</DrillAmount> : formatCurrency(row.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 font-semibold">
              <tr>
                <td colSpan={3} className="px-5 py-3">Totals</td>
                <td className="px-5 py-3 text-right">{formatCurrency(data.totalDebit)}</td>
                <td className="px-5 py-3 text-right">{formatCurrency(data.totalCredit)}</td>
                <td className="px-5 py-3 text-right">{formatCurrency(data.totalDebit - data.totalCredit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <DrilldownDrawer params={drill} onClose={() => setDrill(null)} />

      {!data && !loading && (
        <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
          Select a date and click &quot;Generate&quot;
        </div>
      )}
    </div>
  )
}
