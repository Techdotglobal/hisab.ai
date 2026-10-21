'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatDate } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { ReportActions } from '@/components/data-tools/report-actions'
import { AccountCombobox, type AccountOption } from '@/components/data-tools/account-combobox'
import type { ExportColumn } from '@/lib/export/table-export'
import Link from 'next/link'
import { DrillAmount, DrilldownDrawer, type DrilldownParams } from '@/components/reports/DrilldownDrawer'
import { TracePanel } from '@/components/reports/TracePanel'
import { sourceHref, traceTypeFor } from '@/lib/reporting/source-links'
import { LEDGER_SOURCE_TYPES, ledgerSourceLabel } from '@/lib/accounting/ledger-source-types'
import {
  MONTH_NAMES, PERIOD_KIND_OPTIONS, computePeriodRange, selectionFromDate, validateDateRange,
  type PeriodKind, type PeriodSelection,
} from '@/lib/reporting/period-presets'

interface LedgerEntry {
  date: string; entryNo: string; description: string; debit: number; credit: number
  balance: number; status?: string; sourceType?: string | null; sourceId?: string | null; accountId?: string | null
  account: { accountNo: string; name: string }
  costCenter: { name: string } | null
}
interface LedgerData {
  period: { from: string; to: string }
  entries: LedgerEntry[]
  openingBalance?: number
  closingBalance?: number
  totals: { debit: number; credit: number; balance: number }
  pagination?: { total: number; limit: number; offset: number }
}
interface AppliedFilters { from: string; to: string; accountId: string; sourceType: string }

const inputCls = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 disabled:text-gray-500'
const ytdStart = () => `${new Date().getFullYear()}-01-01`
const today = () => new Date().toISOString().split('T')[0]

export default function GeneralLedgerPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [accountId, setAccountId] = useState('')
  const [periodKind, setPeriodKind] = useState<PeriodKind>('custom')
  const [selection, setSelection] = useState<PeriodSelection>(() => selectionFromDate(ytdStart(), new Date().getFullYear()))
  const [from, setFrom] = useState(ytdStart())
  const [to, setTo] = useState(today())
  const [sourceType, setSourceType] = useState('')
  const [data, setData] = useState<LedgerData | null>(null)
  // Filters the on-screen ledger was generated with; export uses these, not later edits to the form.
  const [applied, setApplied] = useState<AppliedFilters | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [drill, setDrill] = useState<DrilldownParams | null>(null)
  const [traced, setTraced] = useState<{ type: 'invoice' | 'bill' | 'expense'; id: string; label: string; href: string | null } | null>(null)

  useEffect(() => {
    fetch('/api/accounts').then((r) => r.json()).then((d) => setAccounts(Array.isArray(d) ? d : []))
  }, [])

  const postable = useMemo(() => accounts.filter((a) => a.accountNo.length >= 4), [accounts])
  const rangeError = validateDateRange(from, to)

  function applyPeriod(kind: PeriodKind, sel: PeriodSelection) {
    setPeriodKind(kind)
    setSelection(sel)
    const range = computePeriodRange(kind, sel)
    if (range) { setFrom(range.from); setTo(range.to) }
  }
  function changeKind(kind: PeriodKind) {
    // Seed the selectors from the dates currently shown so switching keeps the user's context.
    applyPeriod(kind, kind === 'custom' ? selection : selectionFromDate(from, new Date().getFullYear()))
  }
  const changeSelection = (patch: Partial<PeriodSelection>) => applyPeriod(periodKind, { ...selection, ...patch })

  function buildParams(f: AppliedFilters, extra?: Record<string, string>) {
    const params = new URLSearchParams({ from: f.from, to: f.to, ...extra })
    if (f.accountId) params.set('accountId', f.accountId)
    if (f.sourceType) params.set('sourceType', f.sourceType)
    return params
  }

  async function load() {
    if (rangeError) { setLoadError(rangeError); return }
    setLoading(true)
    setLoadError(null)
    const filters = { from, to, accountId, sourceType }
    try {
      const res = await fetch(`/api/reports/general-ledger?${buildParams(filters)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `Could not load the ledger (${res.status})`)
      }
      setData(await res.json())
      setApplied(filters)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the ledger')
    } finally {
      setLoading(false)
    }
  }

  function clearFilters() {
    setAccountId('')
    setSourceType('')
    setPeriodKind('custom')
    setSelection(selectionFromDate(ytdStart(), new Date().getFullYear()))
    setFrom(ytdStart())
    setTo(today())
    setData(null)
    setApplied(null)
    setLoadError(null)
  }

  const glColumns: ExportColumn<LedgerEntry>[] = [
    { header: 'Date', value: (e) => e.date, type: 'date' }, { header: 'Entry No', value: (e) => e.entryNo }, { header: 'Account No', value: (e) => e.account?.accountNo }, { header: 'Account', value: (e) => e.account?.name },
    { header: 'Description', value: (e) => e.description }, { header: 'Class', value: (e) => ledgerSourceLabel(e.sourceType) }, { header: 'Cost Center', value: (e) => e.costCenter?.name },
    { header: `Debit (${currency})`, value: (e) => e.debit, type: 'currency' }, { header: `Credit (${currency})`, value: (e) => e.credit, type: 'currency' }, { header: `Balance (${currency})`, value: (e) => e.balance, type: 'currency' },
  ]
  // The on-screen ledger is capped at the API page size; export walks every page so it contains
  // the complete filtered dataset. The running balance starts at the period's opening balance.
  async function loadAllEntries(): Promise<LedgerEntry[]> {
    if (!applied || !data) return []
    const pageSize = 1000
    const all: LedgerEntry[] = []
    let offset = 0
    let total = Infinity
    while (offset < total) {
      const params = buildParams(applied, { limit: String(pageSize), offset: String(offset), aggregates: '0' })
      const res = await fetch(`/api/reports/general-ledger?${params}`)
      if (!res.ok) throw new Error(`Could not load ledger (${res.status})`)
      const page = await res.json() as LedgerData
      all.push(...page.entries)
      total = page.pagination?.total ?? all.length
      if (page.entries.length === 0) break
      offset += page.entries.length
    }
    let running = data.openingBalance ?? 0
    return all.map((e) => { running = Math.round((running + e.debit - e.credit) * 10000) / 10000; return { ...e, balance: running } })
  }
  const selectedAccount = accounts.find((a) => a.id === (applied?.accountId ?? accountId))
  const opening = data?.openingBalance ?? 0
  const closing = data?.closingBalance ?? data?.totals.balance ?? 0
  const balanceCell = (n: number) => `${formatCurrency(Math.abs(n))}${n < 0 ? ' Cr' : ''}`
  const yearField = (
    <div>
      <label htmlFor="gl-year" className="block text-xs font-medium text-gray-700 mb-1">Year</label>
      <input id="gl-year" type="number" min={1900} max={9999} value={selection.year}
        onChange={(e) => { const y = Number(e.target.value); if (Number.isInteger(y)) changeSelection({ year: y }) }}
        className={`${inputCls} w-24`} />
    </div>
  )

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">General Ledger</h1>
        <p className="text-gray-500 text-sm mt-0.5">Transaction history by account</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="w-full sm:w-auto sm:min-w-[240px]">
            <label className="block text-xs font-medium text-gray-700 mb-1">Account</label>
            <AccountCombobox accounts={postable} value={accountId} onChange={setAccountId} />
          </div>
          <div>
            <label htmlFor="gl-period" className="block text-xs font-medium text-gray-700 mb-1">Reporting period</label>
            <select id="gl-period" value={periodKind} onChange={(e) => changeKind(e.target.value as PeriodKind)} className={inputCls}>
              {PERIOD_KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {periodKind === 'monthly' && (
            <div>
              <label htmlFor="gl-month" className="block text-xs font-medium text-gray-700 mb-1">Month</label>
              <select id="gl-month" value={selection.month ?? 1} onChange={(e) => changeSelection({ month: Number(e.target.value) })} className={inputCls}>
                {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            </div>
          )}
          {periodKind === 'quarterly' && (
            <div>
              <label htmlFor="gl-quarter" className="block text-xs font-medium text-gray-700 mb-1">Quarter</label>
              <select id="gl-quarter" value={selection.quarter ?? 1} onChange={(e) => changeSelection({ quarter: Number(e.target.value) })} className={inputCls}>
                <option value={1}>Q1 (Jan–Mar)</option><option value={2}>Q2 (Apr–Jun)</option>
                <option value={3}>Q3 (Jul–Sep)</option><option value={4}>Q4 (Oct–Dec)</option>
              </select>
            </div>
          )}
          {periodKind === 'half-yearly' && (
            <div>
              <label htmlFor="gl-half" className="block text-xs font-medium text-gray-700 mb-1">Half</label>
              <select id="gl-half" value={selection.half ?? 1} onChange={(e) => changeSelection({ half: Number(e.target.value) })} className={inputCls}>
                <option value={1}>H1 (Jan–Jun)</option><option value={2}>H2 (Jul–Dec)</option>
              </select>
            </div>
          )}
          {periodKind !== 'custom' && yearField}
          <div>
            <label htmlFor="gl-from" className="block text-xs font-medium text-gray-700 mb-1">From</label>
            <input id="gl-from" type="date" value={from} disabled={periodKind !== 'custom'} aria-invalid={!!rangeError}
              onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="gl-to" className="block text-xs font-medium text-gray-700 mb-1">To</label>
            <input id="gl-to" type="date" value={to} disabled={periodKind !== 'custom'} aria-invalid={!!rangeError}
              onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label htmlFor="gl-class" className="block text-xs font-medium text-gray-700 mb-1">Class of transaction</label>
            <select id="gl-class" value={sourceType} onChange={(e) => setSourceType(e.target.value)} className={inputCls}>
              <option value="">All Classes</option>
              {LEDGER_SOURCE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <ReportActions loading={loading} onApply={load} onClear={clearFilters} applyLabel="View Ledger"
            exportRows={data && applied ? loadAllEntries : null} exportColumns={glColumns} filename="general-ledger" sheetName="General Ledger"
            meta={[
              'General Ledger',
              `Period: ${applied?.from ?? from} to ${applied?.to ?? to}`,
              `Account: ${selectedAccount ? `${selectedAccount.accountNo} - ${selectedAccount.name}` : 'All accounts'}`,
              `Class: ${applied?.sourceType ? ledgerSourceLabel(applied.sourceType) : 'All classes'}`,
              `Opening balance: ${opening}`,
              `Closing balance: ${closing}`,
            ]} />
        </div>
        {rangeError && <p role="alert" className="mt-2 text-xs text-red-600">{rangeError}</p>}
        {loadError && !rangeError && <p role="alert" className="mt-2 text-xs text-red-600">{loadError}</p>}
      </div>

      {data && data.pagination && data.pagination.total > data.entries.length && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Showing the first {data.entries.length.toLocaleString()} of {data.pagination.total.toLocaleString()} ledger lines. Totals and balances cover all {data.pagination.total.toLocaleString()} lines, and exporting includes all {data.pagination.total.toLocaleString()}.
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
                  <th className="px-4 py-3 text-left font-medium">Class</th>
                  <th className="px-4 py-3 text-left font-medium">Cost Center</th>
                  <th className="px-4 py-3 text-right font-medium">Debit</th>
                  <th className="px-4 py-3 text-right font-medium">Credit</th>
                  <th className="px-4 py-3 text-right font-medium">Balance</th>
                  <th className="px-4 py-3 text-center font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <tr className="bg-gray-50/60 text-xs text-gray-600">
                  <td colSpan={9} className="px-4 py-2 font-medium">Opening balance</td>
                  <td className="px-4 py-2 text-right font-mono font-medium">{balanceCell(opening)}</td>
                </tr>
                {data.entries.length === 0 ? (
                  <tr><td colSpan={10} className="px-4 py-8 text-center text-gray-400">No transactions found for this period</td></tr>
                ) : data.entries.map((entry, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-600">{formatDate(entry.date)}</td>
                    <td className="px-4 py-2.5 font-medium text-indigo-600">
                      {(() => {
                        const type = traceTypeFor(entry.sourceType)
                        if (!type || !entry.sourceId) return entry.entryNo
                        const sourceId = entry.sourceId
                        return (
                          <button type="button" className="underline decoration-dotted underline-offset-4 hover:decoration-solid"
                            title="Trace this line back to its source document"
                            onClick={() => setTraced({ type, id: sourceId, label: `${ledgerSourceLabel(entry.sourceType)} · ${entry.entryNo}`, href: sourceHref(entry.sourceType, sourceId) })}>
                            {entry.entryNo}
                          </button>
                        )
                      })()}
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 max-w-xs truncate">{entry.description}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">
                      {entry.accountId && data.period ? (
                        <DrillAmount label={`${entry.account.accountNo} ${entry.account.name}`}
                          onClick={() => setDrill({ metric: 'account', accountId: entry.accountId!, from: applied?.from ?? from, to: applied?.to ?? to })}>
                          {entry.account.accountNo} - {entry.account.name}
                        </DrillAmount>
                      ) : <>{entry.account.accountNo} - {entry.account.name}</>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{ledgerSourceLabel(entry.sourceType) || '—'}</td>
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
                  <td colSpan={6} className="px-4 py-3 text-indigo-700">TOTALS &amp; CLOSING BALANCE</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrency(data.totals.debit)}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrency(data.totals.credit)}</td>
                  <td className="px-4 py-3 text-right font-mono">{balanceCell(closing)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <DrilldownDrawer params={drill} onClose={() => setDrill(null)} />
      {traced && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setTraced(null)}>
          <aside className="h-full w-full max-w-2xl overflow-y-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Accounting trail — {traced.label}</h3>
              <button type="button" onClick={() => setTraced(null)} className="text-xs text-slate-500 hover:text-slate-800">Close</button>
            </div>
            {traced.href && <Link href={traced.href} className="mb-3 inline-block text-xs text-indigo-600 hover:underline">Open source document →</Link>}
            <TracePanel type={traced.type} id={traced.id} />
          </aside>
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
