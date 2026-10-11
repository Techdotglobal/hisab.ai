'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, History, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { ActionDropdown } from '@/components/ui/action-dropdown'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { PageHeader, SearchBar } from '@/components/ui/page-header'
import { FilterPanel, type FilterValues } from '@/components/data-tools/filter-panel'
import { ServerExportMenu } from '@/components/data-tools/server-export-menu'
import { useCompanyCurrency } from '@/hooks/use-company-currency'
import { readApiError } from '@/lib/api-client'
import { formatCurrency } from '@/lib/utils'

type SortKey = 'templateName' | 'type' | 'transactionType' | 'interval' | 'previousDate' | 'nextDate' | 'amount'
type Template = {
  id: string; templateName: string; type: string; transactionType: string; description?: string | null; status: string
  customerId?: string | null; vendorId?: string | null; partyName?: string | null; currency: string; referenceNumber?: string | null
  notes?: string | null; amount: number; transactionPayload: { lines?: TransactionLine[]; category?: string; dueDays?: number }
  schedule: { frequency: string; intervalCount: number; customRule?: Record<string, unknown>; startDate: string; endDate?: string | null; previousDate?: string | null; nextDate?: string | null; timeZone: string; maxRetries?: number; lastError?: string | null }
}
type TransactionLine = { description: string; quantity: number; unitPrice: number; amount?: number; taxRate: number; accountId?: string }
type Party = { id: string; name: string }
type Account = { id: string; name: string; accountNo: string }
type HistoryRow = { id: string; executionDate: string; status: string; generatedTransaction?: string | null; executedBy: string; error?: string | null }

const TRANSACTION_TYPES = ['BILL', 'NON_POSTING_CHARGE', 'CHEQUE', 'NON_POSTING_CREDIT', 'CREDIT_CARD_CREDIT', 'CREDIT_NOTE', 'DEPOSIT', 'ESTIMATE', 'EXPENSE', 'INVOICE', 'JOURNAL_ENTRY', 'PAYMENT', 'SALES_RECEIPT', 'TRANSFER', 'SUPPLIER_CREDIT', 'PURCHASE_ORDER']
const CUSTOMER_TYPES = new Set(['INVOICE', 'ESTIMATE', 'SALES_RECEIPT', 'PAYMENT', 'CREDIT_NOTE', 'NON_POSTING_CHARGE', 'NON_POSTING_CREDIT'])
const VENDOR_TYPES = new Set(['BILL', 'EXPENSE', 'PURCHASE_ORDER', 'SUPPLIER_CREDIT', 'CHEQUE', 'CREDIT_CARD_CREDIT'])
const EMPTY_LINE: TransactionLine = { description: '', quantity: 1, unitPrice: 0, taxRate: 0, accountId: '' }
const today = () => new Date().toISOString().slice(0, 10)
const emptyForm = (currency: string) => ({
  templateName: '', type: 'SCHEDULED', transactionType: 'INVOICE', description: '', status: 'ACTIVE', customerId: '', vendorId: '', currency,
  referenceNumber: '', notes: '', amount: 0, transactionPayload: { lines: [{ ...EMPTY_LINE }], category: 'Recurring', dueDays: 30 },
  schedule: { frequency: 'MONTHLY', intervalCount: 1, startDate: today(), endDate: '', nextRunDate: today(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', maxRetries: 3 },
})

function label(value: string) { return value.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase()) }
function displayDate(value?: string | null) { return value ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value)) : '—' }
function inputDate(value?: string | null) { return value ? new Date(value).toISOString().slice(0, 10) : '' }
function intervalLabel(frequency: string, count: number) { if (frequency === 'CUSTOM') return 'Custom'; const units: Record<string, string> = { DAILY: 'Day', WEEKLY: 'Week', MONTHLY: 'Month', YEARLY: 'Year' }; const unit = units[frequency] ?? label(frequency); return `Every ${count > 1 ? `${count} ` : ''}${unit}${count > 1 ? 's' : ''}` }

function TypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = { REMINDER: 'bg-amber-50 text-amber-700 border-amber-200', SCHEDULED: 'bg-emerald-50 text-emerald-700 border-emerald-200', UNSCHEDULED: 'bg-slate-100 text-slate-600 border-slate-200' }
  return <span className={`badge border ${styles[type] ?? styles.UNSCHEDULED}`}>{label(type)}</span>
}

function SortHeader({ title, value, sortBy, sortDir, onSort, align = 'left' }: { title: string; value: SortKey; sortBy: SortKey; sortDir: string; onSort: (key: SortKey) => void; align?: 'left' | 'right' }) {
  const Icon = sortBy !== value ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown
  return <button type="button" onClick={() => onSort(value)} className={`inline-flex w-full items-center gap-1 hover:text-slate-700 ${align === 'right' ? 'justify-end' : ''}`}>{title}<Icon size={11} /></button>
}

export default function RecurringTransactionsPage() {
  const { currency: companyCurrency } = useCompanyCurrency()
  const [items, setItems] = useState<Template[]>([])
  const [customers, setCustomers] = useState<Party[]>([]); const [vendors, setVendors] = useState<Party[]>([]); const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [workingId, setWorkingId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({ type: '', transactionType: '', interval: '', customerId: '', vendorId: '', status: '', previousDate: '', nextDate: '' })
  const [sortBy, setSortBy] = useState<SortKey>('templateName'); const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1); const [total, setTotal] = useState(0); const limit = 20
  const [formOpen, setFormOpen] = useState(false); const [editing, setEditing] = useState<Template | null>(null); const [viewOnly, setViewOnly] = useState(false)
  const [form, setForm] = useState(emptyForm(companyCurrency)); const [historyFor, setHistoryFor] = useState<Template | null>(null); const [history, setHistory] = useState<HistoryRow[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), limit: String(limit), sortBy, sortDir })
    if (search.trim()) params.set('search', search.trim())
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value) })
    const response = await fetch(`/api/recurring-transactions?${params}`)
    if (response.ok) { const data = await response.json(); setItems(data.items ?? []); setTotal(data.total ?? 0) }
    else alert(await readApiError(response))
    setLoading(false)
  }, [filters, page, search, sortBy, sortDir])

  useEffect(() => { const timer = setTimeout(load, 250); return () => clearTimeout(timer) }, [load])
  useEffect(() => { Promise.all([fetch('/api/customers'), fetch('/api/vendors'), fetch('/api/accounts')]).then(async ([c, v, a]) => {
    if (c.ok) { const data = await c.json(); setCustomers(Array.isArray(data) ? data : data.items ?? []) }
    if (v.ok) { const data = await v.json(); setVendors(Array.isArray(data) ? data : data.items ?? []) }
    if (a.ok) { const data = await a.json(); setAccounts(Array.isArray(data) ? data : data.items ?? []) }
  }) }, [])

  const pageCount = Math.max(1, Math.ceil(total / limit))
  const computedTotal = useMemo(() => form.transactionPayload.lines.reduce((sum, line) => sum + (form.transactionType === 'EXPENSE' ? Number(line.amount ?? line.unitPrice) : line.quantity * line.unitPrice) * (1 + line.taxRate / 100), 0), [form.transactionPayload.lines, form.transactionType])

  function openCreate() { setEditing(null); setViewOnly(false); setForm(emptyForm(companyCurrency)); setFormOpen(true) }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('new') !== '1' || params.get('transactionType') !== 'BILL') return
    const timer = window.setTimeout(() => {
      setEditing(null); setViewOnly(false); setForm({ ...emptyForm(companyCurrency), transactionType: 'BILL' }); setFormOpen(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [companyCurrency])
  function openTemplate(template: Template, view = false) {
    setEditing(template); setViewOnly(view); setForm({ templateName: template.templateName, type: template.type, transactionType: template.transactionType,
      description: template.description ?? '', status: template.status, customerId: template.customerId ?? '', vendorId: template.vendorId ?? '', currency: template.currency,
      referenceNumber: template.referenceNumber ?? '', notes: template.notes ?? '', amount: template.amount,
      transactionPayload: { lines: template.transactionPayload.lines?.length ? template.transactionPayload.lines : [{ ...EMPTY_LINE }], category: template.transactionPayload.category ?? 'Recurring', dueDays: template.transactionPayload.dueDays ?? 30 },
      schedule: { frequency: template.schedule.frequency, intervalCount: template.schedule.intervalCount, startDate: inputDate(template.schedule.startDate), endDate: inputDate(template.schedule.endDate),
        nextRunDate: inputDate(template.schedule.nextDate), timeZone: template.schedule.timeZone || 'UTC', maxRetries: template.schedule.maxRetries ?? 3 } }); setFormOpen(true)
  }
  function changeLine(index: number, patch: Partial<TransactionLine>) { setForm((current) => ({ ...current, transactionPayload: { ...current.transactionPayload, lines: current.transactionPayload.lines.map((line, idx) => idx === index ? { ...line, ...patch } : line) } })) }
  async function save() {
    setSaving(true)
    const response = await fetch(editing ? `/api/recurring-transactions/${editing.id}` : '/api/recurring-transactions', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, amount: computedTotal }) })
    if (response.ok) { setFormOpen(false); await load() } else alert(await readApiError(response))
    setSaving(false)
  }
  async function action(template: Template, name: 'run' | 'pause' | 'resume' | 'duplicate' | 'delete') {
    if (name === 'delete' && !confirm(`Delete “${template.templateName}”? This can be reviewed in audit logs.`)) return
    setWorkingId(template.id)
    const response = await fetch(name === 'delete' ? `/api/recurring-transactions/${template.id}` : `/api/recurring-transactions/${template.id}/${name}`, { method: name === 'delete' ? 'DELETE' : 'POST' })
    if (!response.ok) alert(await readApiError(response)); else await load()
    setWorkingId(null)
  }
  async function openHistory(template: Template) { setHistoryFor(template); const response = await fetch(`/api/recurring-transactions/${template.id}/history`); setHistory(response.ok ? await response.json() : []) }
  function onSort(key: SortKey) { if (sortBy === key) setSortDir((value) => value === 'asc' ? 'desc' : 'asc'); else { setSortBy(key); setSortDir('asc') }; setPage(1) }
  const exportParams = useMemo(() => { const params = new URLSearchParams({ sortBy, sortDir }); if (search.trim()) params.set('search', search.trim()); Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value) }); return params }, [filters, search, sortBy, sortDir])

  return (
    <div className="mx-auto max-w-[1700px] space-y-4 p-4 md:p-6">
      <PageHeader title="Recurring Transactions" subtitle={`${total} templates`} breadcrumb={[{ label: 'Accounting' }, { label: 'Recurring Transactions' }]}
        action={<Button onClick={openCreate}><Plus size={15} /> New recurring transaction</Button>} />

      <div className="flex flex-wrap items-center gap-2">
        <SearchBar value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search by Name" className="w-full sm:w-72" />
        <ServerExportMenu endpoint="/api/recurring-transactions/export" params={exportParams} fallbackFilename="recurring-transactions" />
        <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></Button>
      </div>
      <FilterPanel
        applied={filters}
        onApply={(v: FilterValues) => { setPage(1); setFilters({ type: v.type ?? '', transactionType: v.transactionType ?? '', interval: v.interval ?? '', customerId: v.customerId ?? '', vendorId: v.vendorId ?? '', status: v.status ?? '', previousDate: v.previousDate ?? '', nextDate: v.nextDate ?? '' }) }}
        fields={[
          { key: 'type', label: 'Type', type: 'select', allLabel: 'All types', options: ['REMINDER', 'SCHEDULED', 'UNSCHEDULED'].map((v) => ({ value: v, label: v })) },
          { key: 'transactionType', label: 'Transaction', type: 'select', allLabel: 'All transactions', options: TRANSACTION_TYPES.map((v) => ({ value: v, label: label(v) })) },
          { key: 'interval', label: 'Interval', type: 'select', allLabel: 'All intervals', options: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY', 'CUSTOM'].map((v) => ({ value: v, label: v })) },
          { key: 'customerId', label: 'Customer', type: 'select', allLabel: 'All customers', options: customers.map((v) => ({ value: v.id, label: v.name })) },
          { key: 'vendorId', label: 'Supplier', type: 'select', allLabel: 'All suppliers', options: vendors.map((v) => ({ value: v.id, label: v.name })) },
          { key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: ['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'].map((v) => ({ value: v, label: v })) },
          { key: 'previousDate', label: 'Previous date', type: 'date' },
          { key: 'nextDate', label: 'Next date', type: 'date' },
        ]}
      />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="max-h-[calc(100vh-260px)] overflow-auto">
          <table className="data-table min-w-[1250px] w-full">
            <thead className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50 shadow-[0_1px_0_0_#e2e8f0]">
              <tr>{[
                ['Template Name','templateName'],['Type','type'],['TXN Type','transactionType'],['Interval','interval'],['Previous Date','previousDate'],['Next Date','nextDate'],
              ].map(([title,key]) => <th key={key} className="whitespace-nowrap px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500"><SortHeader title={title} value={key as SortKey} sortBy={sortBy} sortDir={sortDir} onSort={onSort} /></th>)}
                <th className="whitespace-nowrap px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">Customer / Supplier</th>
                <th className="whitespace-nowrap px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wide text-slate-500"><SortHeader title="Amount" value="amount" sortBy={sortBy} sortDir={sortDir} onSort={onSort} align="right" /></th>
                <th className="sticky right-0 bg-slate-50 px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wide text-slate-500">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? Array.from({ length: 7 }, (_, row) => <tr key={row}>{Array.from({ length: 9 }, (_, col) => <td key={col} className="px-3 py-2.5"><div className="skeleton h-4 rounded" /></td>)}</tr>) : items.length === 0 ? (
                <tr><td colSpan={9} className="px-6 py-20 text-center"><RefreshCw size={28} className="mx-auto mb-3 text-slate-300" /><p className="text-sm font-medium text-slate-500">No recurring transactions found.</p><p className="mt-1 text-xs text-slate-400">Create a template or adjust your filters.</p></td></tr>
              ) : items.map((item) => (
                <tr key={item.id} className="text-xs text-slate-600">
                  <td className="px-3 py-2.5 font-semibold text-slate-900"><button className="hover:text-indigo-600" onClick={() => openTemplate(item, true)}>{item.templateName}</button>{item.status !== 'ACTIVE' && <Badge status={item.status} className="ml-2" />}</td>
                  <td className="px-3 py-2.5"><TypeBadge type={item.type} /></td><td className="px-3 py-2.5">{label(item.transactionType)}</td>
                  <td className="px-3 py-2.5">{intervalLabel(item.schedule.frequency, item.schedule.intervalCount)}</td><td className="px-3 py-2.5 whitespace-nowrap">{displayDate(item.schedule.previousDate)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{displayDate(item.schedule.nextDate)}</td><td className="max-w-48 truncate px-3 py-2.5">{item.partyName ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular text-slate-900">{formatCurrency(item.amount, item.currency)}</td>
                  <td className="sticky right-0 bg-white px-3 py-2 text-right">
                    <ActionDropdown items={[
                      { label: 'Edit', onSelect: () => openTemplate(item) }, { label: 'View', onSelect: () => openTemplate(item, true) },
                      { label: 'Duplicate', onSelect: () => action(item, 'duplicate') }, { label: 'Run Now', onSelect: () => action(item, 'run') },
                      { label: 'Pause', onSelect: () => action(item, 'pause'), disabled: item.status !== 'ACTIVE' }, { label: 'Resume', onSelect: () => action(item, 'resume'), disabled: item.status !== 'PAUSED' },
                      { label: 'History', onSelect: () => openHistory(item) }, { label: 'Delete', onSelect: () => action(item, 'delete'), danger: true },
                    ]} label={workingId === item.id ? 'Working…' : 'Edit'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
          <span>{total === 0 ? 0 : (page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}</span>
          <div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><span>Page {page} of {pageCount}</span><Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>Next</Button></div>
        </div>
      </div>

      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={viewOnly ? 'Recurring Transaction' : editing ? 'Edit Recurring Transaction' : 'Create Recurring Transaction'} subtitle="Save an existing transaction shape as a reusable template" size="3xl"
        footer={<><Button variant="outline" onClick={() => setFormOpen(false)}>{viewOnly ? 'Close' : 'Cancel'}</Button>{!viewOnly && <Button loading={saving} onClick={save}>Save Template</Button>}</>}>
        <fieldset disabled={viewOnly} className="space-y-6">
          <section><h3 className="mb-3 text-sm font-bold text-slate-800">General Information</h3><div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Input label="Template Name" required value={form.templateName} onChange={(e) => setForm({ ...form, templateName: e.target.value })} />
            <Select label="Type" required value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{['REMINDER','SCHEDULED','UNSCHEDULED'].map((v) => <option key={v}>{v}</option>)}</Select>
            <Select label="Transaction Type" required value={form.transactionType} onChange={(e) => setForm({ ...form, transactionType: e.target.value, customerId: '', vendorId: '' })}>{TRANSACTION_TYPES.map((v) => <option key={v} value={v}>{label(v)}</option>)}</Select>
            <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{['ACTIVE','PAUSED','COMPLETED','ARCHIVED'].map((v) => <option key={v}>{v}</option>)}</Select>
            <div className="md:col-span-2 xl:col-span-4"><Textarea label="Description" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          </div></section>
          <section><h3 className="mb-3 border-t border-slate-100 pt-5 text-sm font-bold text-slate-800">Schedule</h3><div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
            <Select label="Frequency" value={form.schedule.frequency} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, frequency: e.target.value } })}>{['DAILY','WEEKLY','MONTHLY','YEARLY','CUSTOM'].map((v) => <option key={v}>{v}</option>)}</Select>
            <Input label="Interval" type="number" min="1" value={form.schedule.intervalCount} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, intervalCount: Number(e.target.value) } })} />
            <Input label="Start Date" type="date" required value={form.schedule.startDate} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, startDate: e.target.value } })} />
            <Input label="End Date" type="date" value={form.schedule.endDate} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, endDate: e.target.value } })} />
            <Input label="Next Run Date" type="date" disabled={form.type === 'UNSCHEDULED'} value={form.schedule.nextRunDate} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, nextRunDate: e.target.value } })} />
            <Input label="Time Zone" value={form.schedule.timeZone} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, timeZone: e.target.value } })} />
            <Input label="Max Retries" type="number" min="0" value={form.schedule.maxRetries} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, maxRetries: Number(e.target.value) } })} />
          </div></section>
          <section><h3 className="mb-3 border-t border-slate-100 pt-5 text-sm font-bold text-slate-800">Transaction Information</h3><div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {CUSTOMER_TYPES.has(form.transactionType) && <Select label="Customer" required value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })}><option value="">Select customer…</option>{customers.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>}
            {VENDOR_TYPES.has(form.transactionType) && <Select label="Supplier" required value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })}><option value="">Select supplier…</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>}
            <Input label="Currency" value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
            <Input label="Reference Number" value={form.referenceNumber} onChange={(e) => setForm({ ...form, referenceNumber: e.target.value })} />
            {form.transactionType === 'EXPENSE' && <Input label="Category" value={form.transactionPayload.category} onChange={(e) => setForm({ ...form, transactionPayload: { ...form.transactionPayload, category: e.target.value } })} />}
            <div className="md:col-span-2 xl:col-span-4"><Textarea label="Notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div></section>
          <section><div className="mb-3 flex items-center justify-between border-t border-slate-100 pt-5"><h3 className="text-sm font-bold text-slate-800">Transaction Details</h3><span className="text-sm font-bold text-indigo-600">{formatCurrency(computedTotal, form.currency)}</span></div>
            <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="min-w-[800px] w-full"><thead className="bg-slate-50"><tr>{['Description','Account','Quantity','Unit Price','Tax %','Amount',''].map((v) => <th key={v} className="px-3 py-2 text-left text-[10px] font-semibold uppercase text-slate-500">{v}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{form.transactionPayload.lines.map((line, index) => <tr key={index}>
              <td className="p-2"><input aria-label="Line description" className="input-base text-xs" value={line.description} onChange={(e) => changeLine(index, { description: e.target.value })} /></td>
              <td className="p-2"><select aria-label="Line account" className="input-base bg-white text-xs" value={line.accountId} onChange={(e) => changeLine(index, { accountId: e.target.value })}><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNo} — {a.name}</option>)}</select></td>
              <td className="w-24 p-2"><input aria-label="Quantity" className="input-base text-right text-xs" type="number" min="0" value={line.quantity} onChange={(e) => changeLine(index, { quantity: Number(e.target.value) })} /></td>
              <td className="w-32 p-2"><input aria-label="Unit price" className="input-base text-right text-xs" type="number" min="0" value={line.unitPrice} onChange={(e) => changeLine(index, { unitPrice: Number(e.target.value), amount: Number(e.target.value) })} /></td>
              <td className="w-24 p-2"><input aria-label="Tax rate" className="input-base text-right text-xs" type="number" min="0" value={line.taxRate} onChange={(e) => changeLine(index, { taxRate: Number(e.target.value) })} /></td>
              <td className="w-36 px-3 py-2 text-right text-sm font-semibold tabular">{formatCurrency((form.transactionType === 'EXPENSE' ? Number(line.amount ?? line.unitPrice) : line.quantity * line.unitPrice) * (1 + line.taxRate / 100), form.currency)}</td>
              <td className="w-10 p-2"><button type="button" aria-label="Remove line" onClick={() => setForm((current) => ({ ...current, transactionPayload: { ...current.transactionPayload, lines: current.transactionPayload.lines.filter((_, idx) => idx !== index) } }))} className="rounded-lg p-1.5 text-red-500 hover:bg-red-50"><Trash2 size={14} /></button></td>
            </tr>)}</tbody></table></div><Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setForm((current) => ({ ...current, transactionPayload: { ...current.transactionPayload, lines: [...current.transactionPayload.lines, { ...EMPTY_LINE }] } }))}><Plus size={13} /> Add line</Button>
          </section>
        </fieldset>
      </Modal>

      <Modal open={Boolean(historyFor)} onClose={() => setHistoryFor(null)} title="Execution History" subtitle={historyFor?.templateName} size="xl" footer={<Button variant="outline" onClick={() => setHistoryFor(null)}>Close</Button>}>
        <div className="overflow-x-auto"><table className="w-full min-w-[700px]"><thead><tr className="border-b border-slate-200 bg-slate-50">{['Execution Date','Status','Generated Transaction','Executed By','Error'].map((v) => <th key={v} className="px-3 py-2 text-left text-[10px] font-semibold uppercase text-slate-500">{v}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{history.length ? history.map((row) => <tr key={row.id} className="text-xs"><td className="px-3 py-3">{displayDate(row.executionDate)}</td><td className="px-3 py-3"><Badge status={row.status} /></td><td className="px-3 py-3 font-mono">{row.generatedTransaction ?? '—'}</td><td className="px-3 py-3">{row.executedBy}</td><td className="max-w-xs px-3 py-3 text-red-600">{row.error ?? '—'}</td></tr>) : <tr><td colSpan={5} className="px-3 py-12 text-center text-sm text-slate-400"><History size={24} className="mx-auto mb-2" />No executions yet.</td></tr>}</tbody></table></div>
      </Modal>
    </div>
  )
}
