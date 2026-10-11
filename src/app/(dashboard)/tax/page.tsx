'use client'

import { useEffect, useMemo, useState } from 'react'
import { Eye, Plus, RefreshCw, Search, Shield, SlidersHorizontal } from 'lucide-react'
import { useFormatCurrency } from '@/hooks/use-company-currency'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { ActionDropdown } from '@/components/ui/action-dropdown'
import { ModuleImportExportToolbar } from '@/components/import-export/ModuleImportExportToolbar'
import { TAX_RATE_FIELDS } from '@/lib/import-export/registry/modules/tax-rates.fields'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface TaxRate {
  id: string
  name: string
  percentage?: number
  rate?: number
  type: string
  category?: string
  isDefault: boolean
  isActive: boolean
  createdAt?: string
  updatedAt?: string
}

interface TaxReportApi {
  sales: { amount: number; vatCollected: number; invoiceCount: number }
  purchases: { amount: number; vatPaid: number; billCount: number }
  vatPayable: number
  summary: string
}

const DEFAULT_VAT_RATES: TaxRate[] = [
  { id: 'default-vat', name: 'Standard VAT', percentage: 15, type: 'VAT', isDefault: true, isActive: true },
]

const EMPTY_FORM = { name: '', rate: 15, type: 'VAT', isDefault: false }
const PAGE_SIZE = 10

function getRate(tax: TaxRate) { return Number(tax.percentage ?? tax.rate ?? 0) }
function getScope(type: string) {
  const normalized = type.toUpperCase().replace(/\s+/g, '_')
  if (normalized === 'SALES_TAX' || normalized === 'SALES') return 'Sales'
  if (normalized === 'PURCHASE_TAX' || normalized === 'PURCHASE' || normalized === 'WITHHOLDING') return 'Purchases'
  return 'Both'
}
function typeLabel(type: string) {
  return type.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}
function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-GB').format(date)
}

export default function TaxPage() {
  const formatCurrency = useFormatCurrency()
  const [taxRates, setTaxRates] = useState<TaxRate[]>([])
  const [report, setReport] = useState<TaxReportApi | null>(null)
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [mode, setMode] = useState<'create' | 'edit' | 'view'>('create')
  const [editingTax, setEditingTax] = useState<TaxRate | null>(null)
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [typeFilter, setTypeFilter] = useState('ALL')
  const [scopeFilter, setScopeFilter] = useState('ALL')
  const [rateFilter, setRateFilter] = useState('ALL')
  const [page, setPage] = useState(1)
  const [vatPeriod, setVatPeriod] = useState<FilterValues>({ from: '', to: '' })

  async function load() {
    setLoading(true)
    const [ratesRes, reportRes] = await Promise.all([
      fetch('/api/tax-configurations?includeInactive=true'),
      fetch(`/api/tax/report?${new URLSearchParams(Object.entries(vatPeriod).filter(([, v]) => v))}`),
    ])
    if (ratesRes.ok) {
      const rates = await ratesRes.json()
      setTaxRates(rates.length > 0 ? rates : DEFAULT_VAT_RATES)
    } else {
      setTaxRates(DEFAULT_VAT_RATES)
    }
    if (reportRes.ok) setReport(await reportRes.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [vatPeriod])
  useEffect(() => { setPage(1) }, [search, statusFilter, typeFilter, scopeFilter, rateFilter])

  const types = useMemo(() => Array.from(new Set(taxRates.map(rate => rate.type))).sort(), [taxRates])
  const rateOptions = useMemo(() => Array.from(new Set(taxRates.map(getRate))).sort((a, b) => a - b), [taxRates])
  const filteredRates = useMemo(() => taxRates.filter(tax => {
    const query = search.trim().toLowerCase()
    return (!query || tax.name.toLowerCase().includes(query) || tax.type.toLowerCase().includes(query))
      && (statusFilter === 'ALL' || (statusFilter === 'ACTIVE' ? tax.isActive : !tax.isActive))
      && (typeFilter === 'ALL' || tax.type === typeFilter)
      && (scopeFilter === 'ALL' || getScope(tax.type) === scopeFilter)
      && (rateFilter === 'ALL' || getRate(tax) === Number(rateFilter))
  }), [taxRates, search, statusFilter, typeFilter, scopeFilter, rateFilter])
  const rateExportColumns: ExportColumn<TaxRate>[] = [
    { header: 'Tax Name', value: (t) => t.name }, { header: 'Tax Type', value: (t) => typeLabel(t.type) }, { header: 'Tax Rate (%)', value: (t) => getRate(t), type: 'percent' },
    { header: 'Tax Scope', value: (t) => getScope(t.type) }, { header: 'Status', value: (t) => t.isActive ? 'Active' : 'Inactive' }, { header: 'Default', value: (t) => t.isDefault ? 'Yes' : 'No' },
    { header: 'Last Updated', value: (t) => t.updatedAt ?? t.createdAt, type: 'date' },
  ]
  const vatRows = report ? [
    { line: 'VAT Collected (Output)', base: report.sales.amount, vat: report.sales.vatCollected, count: report.sales.invoiceCount },
    { line: 'VAT Paid (Input)', base: report.purchases.amount, vat: report.purchases.vatPaid, count: report.purchases.billCount },
    { line: report.vatPayable >= 0 ? 'Net VAT Payable' : 'Net VAT Refundable', base: null, vat: Math.abs(report.vatPayable), count: null },
  ] : []
  const vatExportColumns: ExportColumn<(typeof vatRows)[number]>[] = [
    { header: 'VAT Line', value: (r) => r.line }, { header: 'Taxable Amount', value: (r) => r.base, type: 'currency' },
    { header: 'VAT Amount', value: (r) => r.vat, type: 'currency' }, { header: 'Documents', value: (r) => r.count, type: 'number' },
  ]
  const pagedRates = filteredRates.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(filteredRates.length / PAGE_SIZE))

  function openCreate() {
    setMode('create'); setEditingTax(null); setDuplicateOf(null); setForm(EMPTY_FORM); setShowModal(true)
  }
  function openEdit(tax: TaxRate) {
    setMode('edit'); setEditingTax(tax); setDuplicateOf(null)
    setForm({ name: tax.name, rate: getRate(tax), type: tax.type, isDefault: tax.isDefault })
    setShowModal(true)
  }
  function openView(tax: TaxRate) {
    setMode('view'); setEditingTax(tax); setDuplicateOf(null)
    setForm({ name: tax.name, rate: getRate(tax), type: tax.type, isDefault: tax.isDefault })
    setShowModal(true)
  }
  function openDuplicate(tax: TaxRate) {
    setMode('create'); setEditingTax(null); setDuplicateOf(tax.id)
    setForm({ name: `${tax.name} (Copy)`, rate: getRate(tax), type: tax.type, isDefault: false })
    setShowModal(true)
  }

  async function handleSave() {
    setSaving(true)
    const endpoint = mode === 'edit' && editingTax ? `/api/tax-configurations/${editingTax.id}` : '/api/tax-configurations'
    const res = await fetch(endpoint, {
      method: mode === 'edit' ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.name, percentage: form.rate, category: form.type, type: form.type, isDefault: form.isDefault, duplicateOf }),
    })
    if (!res.ok) { alert(await readApiError(res)); setSaving(false); return }
    setShowModal(false); setSaving(false); load()
  }

  async function updateStatus(tax: TaxRate) {
    const res = await fetch(`/api/tax-configurations/${tax.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !tax.isActive }) })
    if (!res.ok) { alert(await readApiError(res)); return }
    load()
  }
  async function deleteTax(tax: TaxRate) {
    if (!window.confirm(`Delete ${tax.name}? This cannot be undone.`)) return
    const res = await fetch(`/api/tax-configurations/${tax.id}`, { method: 'DELETE' })
    if (!res.ok) { alert(await readApiError(res)); return }
    load()
  }

  const vatCollected = report?.sales?.vatCollected ?? 0
  const vatPaid = report?.purchases?.vatPaid ?? 0
  const netVat = report?.vatPayable ?? 0
  const hasFilters = statusFilter !== 'ALL' || typeFilter !== 'ALL' || scopeFilter !== 'ALL' || rateFilter !== 'ALL'

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      <PageHeader title="Tax & ZATCA" subtitle="Tax rates, VAT reporting, Saudi tax authority compliance" breadcrumb={[{ label: 'Reports & Tax' }, { label: 'Tax & ZATCA' }]}
        action={<div className="flex items-center gap-2"><ModuleImportExportToolbar moduleKey="tax-rates" moduleLabel="Tax Rates" fields={TAX_RATE_FIELDS} onImportSuccess={load} tableExport={{ filename: 'tax-rates', columns: rateExportColumns, rows: filteredRates }} /><Button onClick={openCreate}><Plus size={15} /> Add Tax Rate</Button></div>} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[260px] flex-1"><FilterPanel applied={vatPeriod} onApply={setVatPeriod} fields={[{ key: 'from', label: 'VAT period from', type: 'date' }, { key: 'to', label: 'VAT period to', type: 'date' }]} /></div>
        <ExportMenu label="Export VAT Summary" filename="vat-summary" sheetName="VAT Summary" columns={vatExportColumns} rows={vatRows} meta={['VAT Summary', `Period: ${vatPeriod.from || 'start of year'} to ${vatPeriod.to || 'today'}`]} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Metric label="VAT Collected (Output)" value={formatCurrency(vatCollected)} note={report ? `${report.sales.invoiceCount} invoices` : 'From sales invoices'} tone="emerald" />
        <Metric label="VAT Paid (Input)" value={formatCurrency(vatPaid)} note={report ? `${report.purchases.billCount} bills` : 'From purchase bills'} tone="rose" />
        <div className={`rounded-2xl border shadow-sm p-5 ${netVat >= 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}><p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Net VAT {netVat >= 0 ? 'Payable' : 'Refundable'}</p><p className={`text-2xl font-bold tabular ${netVat >= 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{formatCurrency(Math.abs(netVat))}</p><p className="text-xs text-slate-500 mt-1">{report?.summary ?? (netVat >= 0 ? 'Amount due to ZATCA' : 'Refund from ZATCA')}</p></div>
      </div>

      <div className="bg-gradient-to-br from-indigo-900 to-violet-900 rounded-2xl p-6 text-white"><div className="flex items-center gap-3 mb-4"><div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center"><Shield size={20} /></div><div><h3 className="font-semibold">ZATCA Integration</h3><p className="text-indigo-200 text-xs">Saudi Zakat, Tax and Customs Authority</p></div></div><div className="grid sm:grid-cols-3 gap-4">{[{ label: 'Standard VAT Rate', value: '15%', note: 'Saudi Arabia VAT' }, { label: 'E-invoicing', value: 'Phase 2', note: 'Fatoorah compliant' }, { label: 'Reporting', value: 'Quarterly', note: 'VAT return filing' }].map(item => <div key={item.label} className="bg-white/10 rounded-xl p-4"><p className="text-xs text-indigo-200">{item.label}</p><p className="text-lg font-bold mt-1">{item.value}</p><p className="text-xs text-indigo-300 mt-0.5">{item.note}</p></div>)}</div></div>

      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><h2 className="text-sm font-semibold text-slate-900">Tax List</h2><p className="text-xs text-slate-500 mt-0.5">Manage configured tax rates without changing tax calculation settings.</p></div><button onClick={load} aria-label="Refresh tax list" className="self-end lg:self-auto p-1.5 text-slate-400 hover:text-slate-600 transition-colors"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button></div>
        <div className="p-4 border-b border-slate-100 space-y-3"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><Input aria-label="Search taxes" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search name or type" leftIcon={<Search size={16} />} /><Select aria-label="Filter by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></Select><Select aria-label="Filter by tax type" value={typeFilter} onChange={event => setTypeFilter(event.target.value)}><option value="ALL">All tax types</option>{types.map(type => <option key={type} value={type}>{typeLabel(type)}</option>)}</Select><Select aria-label="Filter by tax scope" value={scopeFilter} onChange={event => setScopeFilter(event.target.value)}><option value="ALL">Sales & purchases</option><option value="Sales">Sales</option><option value="Purchases">Purchases</option><option value="Both">Both</option></Select><Select aria-label="Filter by rate" value={rateFilter} onChange={event => setRateFilter(event.target.value)}><option value="ALL">All tax rates</option>{rateOptions.map(rate => <option key={rate} value={rate}>{rate}%</option>)}</Select></div>{hasFilters && <div className="flex flex-wrap items-center gap-2 text-xs"><SlidersHorizontal size={14} className="text-slate-400" />{statusFilter !== 'ALL' && <FilterChip label={statusFilter === 'ACTIVE' ? 'Active' : 'Inactive'} onRemove={() => setStatusFilter('ALL')} />}{typeFilter !== 'ALL' && <FilterChip label={typeLabel(typeFilter)} onRemove={() => setTypeFilter('ALL')} />}{scopeFilter !== 'ALL' && <FilterChip label={scopeFilter} onRemove={() => setScopeFilter('ALL')} />}{rateFilter !== 'ALL' && <FilterChip label={`${rateFilter}%`} onRemove={() => setRateFilter('ALL')} />}</div>}</div>
        <div className="overflow-x-auto"><table className="w-full data-table min-w-[980px]"><thead><tr className="border-b border-slate-100">{['Tax Name', 'Tax Type', 'Tax Rate', 'Tax Scope', 'Status', 'Default', 'Last Updated', 'Actions'].map(header => <th key={header} className="px-4 py-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{header}</th>)}</tr></thead><tbody className="divide-y divide-slate-50">{loading ? Array.from({ length: 5 }).map((_, row) => <tr key={row}>{Array.from({ length: 8 }).map((_, cell) => <td key={cell} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>) : pagedRates.length ? pagedRates.map(tax => <tr key={tax.id} className="hover:bg-slate-50/60"><td className="px-4 py-3 font-semibold text-slate-800">{tax.name}</td><td className="px-4 py-3"><span className="badge bg-indigo-50 text-indigo-700 border border-indigo-200">{typeLabel(tax.type)}</span></td><td className="px-4 py-3 font-bold text-slate-900 tabular">{getRate(tax)}%</td><td className="px-4 py-3 text-slate-600">{getScope(tax.type)}</td><td className="px-4 py-3"><span className={`badge border ${tax.isActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>{tax.isActive ? 'Active' : 'Inactive'}</span></td><td className="px-4 py-3">{tax.isDefault ? <span className="badge bg-amber-50 text-amber-700 border border-amber-200">Yes</span> : <span className="text-slate-500">No</span>}</td><td className="px-4 py-3 text-sm text-slate-500">{formatDate(tax.updatedAt ?? tax.createdAt)}</td><td className="px-4 py-3"><ActionDropdown label="Actions" items={[{ label: 'View', onSelect: () => openView(tax) }, { label: 'Edit', onSelect: () => openEdit(tax) }, { label: 'Duplicate', onSelect: () => openDuplicate(tax) }, { label: tax.isActive ? 'Deactivate' : 'Activate', onSelect: () => updateStatus(tax) }, { label: 'Delete', onSelect: () => deleteTax(tax), danger: true }]} /></td></tr>) : <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-slate-500">No configured taxes match these filters.</td></tr>}</tbody></table></div>
        {!loading && filteredRates.length > 0 && <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500"><span>{filteredRates.length} configured {filteredRates.length === 1 ? 'tax' : 'taxes'}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Previous</Button><span className="self-center">{page} / {pageCount}</span><Button size="sm" variant="outline" disabled={page === pageCount} onClick={() => setPage(value => value + 1)}>Next</Button></div></div>}
      </section>

      <Modal open={showModal} onClose={() => setShowModal(false)} title={mode === 'view' ? 'Tax Rate Details' : mode === 'edit' ? 'Edit Tax Rate' : duplicateOf ? 'Duplicate Tax Rate' : 'New Tax Rate'} size="sm" footer={<>{mode !== 'view' && <Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>}{mode === 'view' ? <Button onClick={() => setShowModal(false)}>Close</Button> : <Button onClick={handleSave} loading={saving}>Save</Button>}</>}><div className="space-y-4"><Input label="Rate Name" required disabled={mode === 'view'} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="VAT 15%" /><div className="grid grid-cols-2 gap-3"><Input label="Rate (%)" type="number" min="0" max="100" required disabled={mode === 'view'} value={form.rate} onChange={event => setForm({ ...form, rate: parseFloat(event.target.value) || 0 })} /><Select label="Tax Type" disabled={mode === 'view'} value={form.type} onChange={event => setForm({ ...form, type: event.target.value })}><option value="VAT">VAT</option><option value="SALES_TAX">Sales Tax</option><option value="PURCHASE_TAX">Purchase Tax</option><option value="WITHHOLDING">Withholding Tax</option></Select></div><p className="text-xs text-slate-500">Scope: <span className="font-semibold text-slate-700">{getScope(form.type)}</span></p><label className="flex items-center gap-2.5 cursor-pointer"><input type="checkbox" disabled={mode === 'view'} checked={form.isDefault} onChange={event => setForm({ ...form, isDefault: event.target.checked })} className="w-4 h-4 rounded border-slate-300 text-indigo-600" /><span className="text-sm text-slate-600">Set as default tax rate</span></label>{mode === 'view' && <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 flex gap-2 items-center"><Eye size={14} /> Tax configuration is read-only in this view.</div>}</div></Modal>
    </div>
  )
}

function Metric({ label, value, note, tone }: { label: string; value: string; note: string; tone: 'emerald' | 'rose' }) {
  return <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5"><p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">{label}</p><p className={`text-2xl font-bold tabular ${tone === 'emerald' ? 'text-emerald-600' : 'text-rose-600'}`}>{value}</p><p className="text-xs text-slate-400 mt-1">{note}</p></div>
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 font-medium text-indigo-700">{label}<button type="button" onClick={onRemove} aria-label={`Remove ${label} filter`} className="ml-0.5 text-indigo-500 hover:text-indigo-800">×</button></span>
}
