'use client'

import { useState } from 'react'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { DrilldownDrawer, DrillAmount, type DrilldownParams } from '@/components/reports/DrilldownDrawer'
import { ReportActions } from '@/components/data-tools/report-actions'
import type { ExportColumn } from '@/lib/export/table-export'

interface BsItem { accountId?: string; accountNo: string; name: string; balance: number }

interface BSData {
  asOf: string
  assets: { items: BsItem[]; total: number }
  liabilities: { items: BsItem[]; total: number }
  equity: { items: BsItem[]; total: number }
  totalLiabilitiesAndEquity: number
  isBalanced?: boolean
}

function Section({ title, items, total, color, onAccount, onTotal }: {
  title: string; items: BsItem[]
  total: number; color: string
  onAccount: (item: BsItem) => void; onTotal: () => void
}) {
  const formatCurrency = useFormatCurrency()
  return (
    <div>
      <h3 className={`text-sm font-bold uppercase tracking-wide px-5 py-2.5 ${color}`}>{title}</h3>
      {items.map((item) => (
        item.balance !== 0 && (
          <div key={item.accountId ?? item.accountNo} className="flex justify-between px-5 py-2 border-b text-sm hover:bg-gray-50">
            <span className="text-gray-600">{item.name}</span>
            <span className="font-medium text-gray-800">{item.accountId ? <DrillAmount label={item.name} onClick={() => onAccount(item)}>{formatCurrency(item.balance)}</DrillAmount> : formatCurrency(item.balance)}</span>
          </div>
        )
      ))}
      <div className="flex justify-between px-5 py-2.5 bg-gray-50 font-semibold text-sm">
        <span>Total {title}</span>
        <span><DrillAmount label={`Total ${title}`} onClick={onTotal}>{formatCurrency(total)}</DrillAmount></span>
      </div>
    </div>
  )
}

export default function BalanceSheetPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [asOf, setAsOf] = useState(new Date().toISOString().split('T')[0])
  const [data, setData] = useState<BSData | null>(null)
  const [loading, setLoading] = useState(false)
  const [drill, setDrill] = useState<DrilldownParams | null>(null)
  const reportDate = data ? data.asOf.slice(0, 10) : asOf
  const openAccount = (item: BsItem) =>
    setDrill(item.accountId === 'current-period-earnings' ? { metric: 'bs.earnings', asOf: reportDate } : { metric: 'account', accountId: item.accountId, asOf: reportDate })

  async function load() {
    setLoading(true)
    const res = await fetch(`/api/reports/balance-sheet?asOf=${asOf}`)
    if (res.ok) setData(await res.json())
    setLoading(false)
  }

  type BsRow = { section: string; accountNo: string; account: string; balance: number }
  const bsRows: BsRow[] | null = data ? [
    ...data.assets.items.filter((i) => i.balance !== 0).map((i) => ({ section: 'Assets', accountNo: i.accountNo, account: i.name, balance: i.balance })),
    { section: 'Assets', accountNo: '', account: 'Total Assets', balance: data.assets.total },
    ...data.liabilities.items.filter((i) => i.balance !== 0).map((i) => ({ section: 'Liabilities', accountNo: i.accountNo, account: i.name, balance: i.balance })),
    { section: 'Liabilities', accountNo: '', account: 'Total Liabilities', balance: data.liabilities.total },
    ...data.equity.items.filter((i) => i.balance !== 0).map((i) => ({ section: 'Equity', accountNo: i.accountNo, account: i.name, balance: i.balance })),
    { section: 'Equity', accountNo: '', account: 'Total Equity', balance: data.equity.total },
    { section: 'Summary', accountNo: '', account: 'Total Liabilities & Equity', balance: data.totalLiabilitiesAndEquity },
  ] : null
  const bsColumns: ExportColumn<BsRow>[] = [
    { header: 'Section', value: (r) => r.section }, { header: 'Account No', value: (r) => r.accountNo }, { header: 'Account', value: (r) => r.account }, { header: `Balance (${currency})`, value: (r) => r.balance, type: 'currency' },
  ]

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Balance Sheet</h1>
        <p className="text-gray-500 text-sm mt-0.5">Financial position as of a specific date</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">As of Date</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
                    <ReportActions loading={loading} onApply={load} onClear={() => { setAsOf(new Date().toISOString().split('T')[0]); setData(null) }} applyLabel="Generate"
            exportRows={bsRows} exportColumns={bsColumns} filename="balance-sheet" sheetName="Balance Sheet"
            meta={['Balance Sheet', `As of: ${asOf}`, `Currency: ${currency}`]} />
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Assets */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b bg-blue-600">
              <h2 className="text-white font-bold text-base">ASSETS</h2>
            </div>
            <Section title="Assets" items={data.assets.items} total={data.assets.total} color="bg-blue-50 text-blue-700" onAccount={openAccount} onTotal={() => setDrill({ metric: 'bs.assets', asOf: reportDate })} />
            <div className="flex justify-between px-5 py-3 bg-blue-600 text-white font-bold">
              <span>TOTAL ASSETS</span>
              <span>{formatCurrency(data.assets.total)}</span>
            </div>
          </div>

          {/* Liabilities + Equity */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b bg-orange-600">
              <h2 className="text-white font-bold text-base">LIABILITIES & EQUITY</h2>
            </div>
            <Section title="Liabilities" items={data.liabilities.items} total={data.liabilities.total} color="bg-orange-50 text-orange-700" onAccount={openAccount} onTotal={() => setDrill({ metric: 'bs.liabilities', asOf: reportDate })} />
            <Section title="Equity" items={data.equity.items} total={data.equity.total} color="bg-purple-50 text-purple-700" onAccount={openAccount} onTotal={() => setDrill({ metric: 'bs.equity', asOf: reportDate })} />
            <div className="flex justify-between px-5 py-3 bg-orange-600 text-white font-bold">
              <span>TOTAL LIABILITIES & EQUITY</span>
              <span>{formatCurrency(data.totalLiabilitiesAndEquity)}</span>
            </div>
          </div>
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
