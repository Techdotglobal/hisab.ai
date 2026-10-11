'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, FileOutput } from 'lucide-react'
import { formatDate, formatCurrency as formatAmount, cn } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { ALLOWED_CURRENCIES } from '@/lib/currency/constants'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select, Textarea } from '@/components/ui/input'
import { PageHeader, SearchBar, FilterBar } from '@/components/ui/page-header'

interface Customer { id: string; name: string }
interface Account { id: string; accountNo: string; name: string }
interface EstimateLine { description: string; quantity: number; unitPrice: number; taxRate: number; accountId?: string }
interface Estimate {
  id: string; estimateNo: string; customer: { name: string }; date: string; expiryDate?: string
  total: number; status: string; currency?: string
}

const STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED']
const EMPTY_LINE: EstimateLine = { description: '', quantity: 1, unitPrice: 0, taxRate: 15, accountId: '' }

export default function EstimatesPage() {
  const formatPrimary = useFormatCurrency()
  const { currency: primaryCurrency } = useCompanyCurrency()
  const [estimates, setEstimates] = useState<Estimate[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterValues>({ status: '', party: '', from: '', to: '', min: '', max: '' })
  const statusFilter = filters.status
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState({
    customerId: '', date: new Date().toISOString().split('T')[0],
    expiryDate: '', notes: '', currency: primaryCurrency,
    lines: [{ ...EMPTY_LINE }],
  })

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (statusFilter) params.set('status', statusFilter)
    const [estRes, custRes, accRes] = await Promise.all([
      fetch(`/api/estimates?${params}`),
      fetch('/api/customers'),
      fetch('/api/accounts'),
    ])
    if (estRes.ok) setEstimates(await estRes.json())
    if (custRes.ok) setCustomers(await custRes.json())
    if (accRes.ok) setAccounts(await accRes.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [search, statusFilter])

  function updateLine(idx: number, field: string, value: string | number) {
    setForm(f => ({ ...f, lines: f.lines.map((l, i) => i === idx ? { ...l, [field]: value } : l) }))
  }

  const subtotal = form.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
  const taxAmount = form.lines.reduce((s, l) => s + l.quantity * l.unitPrice * (l.taxRate / 100), 0)
  const total = subtotal + taxAmount
  const formatFormAmount = (amount: number) => formatAmount(amount, form.currency)
  const formatEstimateAmount = (est: Estimate, amount: number) => formatAmount(amount, est.currency ?? primaryCurrency)

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/estimates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    })
    if (!res.ok) {
      alert(await readApiError(res))
      setSaving(false)
      return
    }
    setShowModal(false)
    load()
    setSaving(false)
  }

  async function handleConvert(id: string) {
    const res = await fetch(`/api/estimates/${id}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ send: true }),
    })
    if (!res.ok) {
      alert(await readApiError(res))
      return
    }
    load()
  }

  const visible = useMemo(() => estimates.filter((r) => {
    if (filters.party && r.customer?.name !== filters.party) return false
    const min = filters.min === '' ? null : Number(filters.min); const max = filters.max === '' ? null : Number(filters.max)
    if ((min !== null && r.total < min) || (max !== null && r.total > max)) return false
    return inDateRange(r.date, filters.from, filters.to)
  }), [estimates, filters])
  const exportColumns: ExportColumn<Estimate>[] = [
    { header: 'Estimate No', value: (r) => r.estimateNo }, { header: 'Customer', value: (r) => r.customer?.name }, { header: 'Date', value: (r) => r.date, type: 'date' },
    { header: 'Expiry Date', value: (r) => r.expiryDate, type: 'date' }, { header: 'Currency', value: (r) => r.currency }, { header: 'Total', value: (r) => r.total, type: 'currency' }, { header: 'Status', value: (r) => r.status },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Estimates"
        subtitle={`${estimates.length} estimates · ${formatPrimary(estimates.reduce((s, e) => s + e.total, 0))} total`}
        breadcrumb={[{ label: 'Income' }, { label: 'Estimates' }]}
        action={<Button onClick={() => setShowModal(true)}><Plus size={15} /> New Estimate</Button>}
      />

      <FilterBar>
        <SearchBar value={search} onChange={setSearch} placeholder="Search estimates..." className="flex-1 max-w-sm" />
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="estimates" sheetName="Estimates" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'party', label: 'Customer', type: 'select', allLabel: 'All', options: customers.map((x) => ({ value: x.name, label: x.name })) }, { key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: STATUSES.map((x) => ({ value: x, label: x })) }, { key: 'from', label: 'Date from', type: 'date' }, { key: 'to', label: 'Date to', type: 'date' }, { key: 'min', label: 'Min total', type: 'number' }, { key: 'max', label: 'Max total', type: 'number' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['Estimate #', 'Customer', 'Date', 'Expiry', 'Total', 'Status', ''].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left', h === 'Total' && 'text-right', h === '' && 'w-28')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 7 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : visible.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-slate-400 text-sm">No estimates found.</td></tr>
              ) : visible.map(est => (
                <tr key={est.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-indigo-600">{est.estimateNo}</td>
                  <td className="px-4 py-3 text-sm text-slate-700">{est.customer?.name}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(est.date)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{est.expiryDate ? formatDate(est.expiryDate) : '—'}</td>
                  <td className="px-4 py-3 text-right text-sm font-semibold tabular">{formatEstimateAmount(est, est.total)}</td>
                  <td className="px-4 py-3"><Badge status={est.status} /></td>
                  <td className="px-4 py-3">
                    {est.status !== 'CONVERTED' && (
                      <button onClick={() => handleConvert(est.id)}
                        className="flex items-center gap-1 text-[11px] font-semibold text-emerald-600 hover:bg-emerald-50 px-2 py-1 rounded-lg">
                        <FileOutput size={10} /> Convert
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Estimate" size="xl"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save Estimate</Button></>}>
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Select label="Customer" required value={form.customerId} onChange={e => setForm({ ...form, customerId: e.target.value })}>
              <option value="">Select customer...</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input label="Date" type="date" required value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <Input label="Expiry Date" type="date" value={form.expiryDate} onChange={e => setForm({ ...form, expiryDate: e.target.value })} />
            <Select label="Currency" value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })}>
              {ALLOWED_CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
            </Select>
          </div>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead><tr className="bg-slate-50 border-b">{['Description', 'Account', 'Qty', 'Price', 'Tax %', 'Amount', ''].map(h => (
                <th key={h} className="px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase text-left">{h}</th>
              ))}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {form.lines.map((line, idx) => (
                  <tr key={idx}>
                    <td className="px-2 py-2"><input value={line.description} onChange={e => updateLine(idx, 'description', e.target.value)} className="input-base text-xs py-1.5" /></td>
                    <td className="px-2 py-2"><select value={line.accountId} onChange={e => updateLine(idx, 'accountId', e.target.value)} className="input-base text-xs py-1.5 bg-white">
                      <option value="">—</option>{accounts.filter(a => a.accountNo.startsWith('41')).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select></td>
                    <td className="px-2 py-2 w-20"><input type="number" value={line.quantity} onChange={e => updateLine(idx, 'quantity', parseFloat(e.target.value) || 0)} className="input-base text-xs py-1.5 text-right" /></td>
                    <td className="px-2 py-2 w-28"><input type="number" value={line.unitPrice} onChange={e => updateLine(idx, 'unitPrice', parseFloat(e.target.value) || 0)} className="input-base text-xs py-1.5 text-right" /></td>
                    <td className="px-2 py-2 w-20"><input type="number" value={line.taxRate} onChange={e => updateLine(idx, 'taxRate', parseFloat(e.target.value) || 0)} className="input-base text-xs py-1.5 text-right" /></td>
                    <td className="px-3 py-2 text-right text-sm font-semibold tabular">{formatFormAmount(line.quantity * line.unitPrice * (1 + line.taxRate / 100))}</td>
                    <td className="px-2 py-2 text-center"><button onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }))} className="text-red-400">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="bg-slate-50 border-t px-4 py-3 text-right text-sm font-bold text-indigo-600">Total: {formatFormAmount(total)}</div>
          </div>
          <button onClick={() => setForm(f => ({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] }))} className="text-sm text-indigo-600 font-medium flex items-center gap-1"><Plus size={14} /> Add Line</button>
          <Textarea label="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} />
        </div>
      </Modal>
    </div>
  )
}
