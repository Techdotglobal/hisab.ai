'use client'

import { useEffect, useState } from 'react'
import { formatDate } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { ReportActions } from '@/components/data-tools/report-actions'
import type { ExportColumn } from '@/lib/export/table-export'

interface Account { id: string; accountNo: string; name: string }
interface LedgerEntry {
  date: string; entryNo: string; description: string; debit: number; credit: number
  balance: number; status: string; account: { accountNo: string; name: string }
  costCenter: { name: string } | null
}
interface LedgerData {
  period: { from: string; to: string }
  entries: LedgerEntry[]
  totals: { debit: number; credit: number; balance: number }
  pagination?: { total: number; limit: number; offset: number }
}

export default function GeneralLedgerPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState('')
  const [from, setFrom] = useState(new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0])
  const [to, setTo] = useState(new Date().toISOString().split('T')[0])
  const [data, setData] = useState<LedgerData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/accounts').then((r) => r.json()).then((d) => setAccounts(d))
  }, [])

  async function load() {
    setLoading(true)
    const params = new URLSearchParams({ from, to })
    if (accountId) params.set('accountId', accountId)
    const res = await fetch(`/api/reports/general-ledger?${params}`)
    if (res.ok) setData(await res.json())
    setLoading(false)
  }

  const glColumns: ExportColumn<LedgerEntry>[] = [
    { header: 'Date', value: (e) => e.date, type: 'date' }, { header: 'Entry No', value: (e) => e.entryNo }, { header: 'Account No', value: (e) => e.account?.accountNo }, { header: 'Account', value: (e) => e.account?.name },
    { header: 'Description', value: (e) => e.description }, { header: 'Cost Center', value: (e) => e.costCenter?.name }, { header: 'Status', value: (e) => e.status },
    { header: `Debit (${currency})`, value: (e) => e.debit, type: 'currency' }, { header: `Credit (${currency})`, value: (e) => e.credit, type: 'currency' }, { header: `Balance (${currency})`, value: (e) => e.balance, type: 'currency' },
  ]
  // The on-screen ledger is capped at the API page size; export walks every page so it contains
  // the complete filtered dataset, recomputing the running balance across page boundaries.
  async function loadAllEntries(): Promise<LedgerEntry[]> {
    const pageSize = 1000
    const all: LedgerEntry[] = []
    let offset = 0
    let total = Infinity
    while (offset < total) {
      const params = new URLSearchParams({ from, to, limit: String(pageSize), offset: String(offset) })
      if (accountId) params.set('accountId', accountId)
      const res = await fetch(`/api/reports/general-ledger?${params}`)
      if (!res.ok) throw new Error(`Could not load ledger (${res.status})`)
      const page = await res.json() as LedgerData
      all.push(...page.entries)
      total = page.pagination?.total ?? all.length
      if (page.entries.length === 0) break
      offset += page.entries.length
    }
    let running = 0
    return all.map((e) => { running += e.debit - e.credit; return { ...e, balance: running } })
  }
  const selectedAccount = accounts.find((a) => a.id === accountId)

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">General Ledger</h1>
        <p className="text-gray-500 text-sm mt-0.5">Transaction history by account</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 min-w-[220px]">
              <option value="">All Accounts</option>
              {accounts.filter(a => a.accountNo.length >= 4).map((a) => (
                <option key={a.id} value={a.id}>{a.accountNo} - {a.name}</option>
              ))}
            </select>
          </div>
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
                    <ReportActions loading={loading} onApply={load} onClear={() => { setAccountId(''); setFrom(new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0]); setTo(new Date().toISOString().split('T')[0]); setData(null) }} applyLabel="View Ledger"
            exportRows={data ? loadAllEntries : null} exportColumns={glColumns} filename="general-ledger" sheetName="General Ledger"
            meta={['General Ledger', `Period: ${from} to ${to}`, `Account: ${selectedAccount ? `${selectedAccount.accountNo} - ${selectedAccount.name}` : 'All accounts'}`]} />
        </div>
      </div>

      {data && data.pagination && data.pagination.total > data.entries.length && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Showing the first {data.entries.length.toLocaleString()} of {data.pagination.total.toLocaleString()} ledger lines. Exporting includes all {data.pagination.total.toLocaleString()}.
        </p>
      )}

      {data && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-xs text-gray-500 uppercase">
                  <th className="px-4 py-3 text-left font-medium">Date</th>
                  <th className="px-4 py-3 text-left font-medium">Entry No.</th>
                  <th className="px-4 py-3 text-left font-medium">Description</th>
                  <th className="px-4 py-3 text-left font-medium">Account</th>
                  <th className="px-4 py-3 text-left font-medium">Cost Center</th>
                  <th className="px-4 py-3 text-right font-medium">Debit</th>
                  <th className="px-4 py-3 text-right font-medium">Credit</th>
                  <th className="px-4 py-3 text-right font-medium">Balance</th>
                  <th className="px-4 py-3 text-center font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.entries.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">No transactions found for this period</td></tr>
                ) : data.entries.map((entry, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-600">{formatDate(entry.date)}</td>
                    <td className="px-4 py-2.5 font-medium text-indigo-600">{entry.entryNo}</td>
                    <td className="px-4 py-2.5 text-gray-700 max-w-xs truncate">{entry.description}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{entry.account.accountNo} - {entry.account.name}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{entry.costCenter?.name || '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{entry.debit > 0 ? formatCurrency(entry.debit) : '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{entry.credit > 0 ? formatCurrency(entry.credit) : '—'}</td>
                    <td className={`px-4 py-2.5 text-right font-mono font-medium ${entry.balance >= 0 ? 'text-gray-800' : 'text-red-600'}`}>
                      {formatCurrency(Math.abs(entry.balance))}{entry.balance < 0 ? ' Cr' : ''}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${entry.status === 'POSTED' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                        {entry.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-indigo-50 font-bold text-sm border-t-2 border-indigo-200">
                  <td colSpan={5} className="px-4 py-3 text-indigo-700">TOTALS</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrency(data.totals.debit)}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrency(data.totals.credit)}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrency(Math.abs(data.totals.balance))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {!data && !loading && (
        <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
          Select filters and click &quot;View Ledger&quot;
        </div>
      )}
    </div>
  )
}
