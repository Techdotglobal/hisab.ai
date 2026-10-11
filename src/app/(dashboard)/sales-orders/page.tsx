'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
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
interface OrderLine { description: string; quantity: number; unitPrice: number; taxRate: number; accountId?: string }
interface SalesOrder {
  id: string; orderNo: string; customer: { name: string }; date: string
  total: number; status: string; currency?: string
}

const STATUSES = ['OPEN', 'FULFILLED', 'CANCELLED']
const EMPTY_LINE: OrderLine = { description: '', quantity: 1, unitPrice: 0, taxRate: 15, accountId: '' }

export default function SalesOrdersPage() {
  const formatPrimary = useFormatCurrency()
  const { currency: primaryCurrency } = useCompanyCurrency()
  const [orders, setOrders] = useState<SalesOrder[]>([])
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
    notes: '', currency: primaryCurrency,
    lines: [{ ...EMPTY_LINE }],
  })

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (statusFilter) params.set('status', statusFilter)
    const [ordRes, custRes, accRes] = await Promise.all([
      fetch(`/api/sales-orders?${params}`),
      fetch('/api/customers'),
      fetch('/api/accounts'),
    ])
    if (ordRes.ok) setOrders(await ordRes.json())
    if (custRes.ok) setCustomers(await custRes.json())
    if (accRes.ok) setAccounts(await accRes.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [search, statusFilter])

  function updateLine(idx: number, field: string, value: string | number) {
    setForm(f => ({ ...f, lines: f.lines.map((l, i) => i === idx ? { ...l, [field]: value } : l) }))
  }

  const total = form.lines.reduce((s, l) => s + l.quantity * l.unitPrice * (1 + l.taxRate / 100), 0)
  const formatFormAmount = (amount: number) => formatAmount(amount, form.currency)
  const formatOrderAmount = (order: SalesOrder, amount: number) => formatAmount(amount, order.currency ?? primaryCurrency)

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/sales-orders', {
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

  const visible = useMemo(() => orders.filter((r) => {
    if (filters.party && r.customer?.name !== filters.party) return false
    const min = filters.min === '' ? null : Number(filters.min); const max = filters.max === '' ? null : Number(filters.max)
    if ((min !== null && r.total < min) || (max !== null && r.total > max)) return false
    return inDateRange(r.date, filters.from, filters.to)
  }), [orders, filters])
  const exportColumns: ExportColumn<SalesOrder>[] = [
    { header: 'Order No', value: (r) => r.orderNo }, { header: 'Customer', value: (r) => r.customer?.name }, { header: 'Date', value: (r) => r.date, type: 'date' },
    { header: 'Currency', value: (r) => r.currency }, { header: 'Total', value: (r) => r.total, type: 'currency' }, { header: 'Status', value: (r) => r.status },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Sales Orders"
        subtitle={`${orders.length} orders · ${formatPrimary(orders.reduce((s, o) => s + o.total, 0))} total`}
        breadcrumb={[{ label: 'Income' }, { label: 'Sales Orders' }]}
        action={<Button onClick={() => setShowModal(true)}><Plus size={15} /> New Order</Button>}
      />

      <FilterBar>
        <SearchBar value={search} onChange={setSearch} placeholder="Search orders..." className="flex-1 max-w-sm" />
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="sales-orders" sheetName="Sales Orders" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'party', label: 'Customer', type: 'select', allLabel: 'All', options: customers.map((x) => ({ value: x.name, label: x.name })) }, { key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: STATUSES.map((x) => ({ value: x, label: x })) }, { key: 'from', label: 'Date from', type: 'date' }, { key: 'to', label: 'Date to', type: 'date' }, { key: 'min', label: 'Min total', type: 'number' }, { key: 'max', label: 'Max total', type: 'number' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['Order #', 'Customer', 'Date', 'Total', 'Status'].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left', h === 'Total' && 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 5 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : visible.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-16 text-center text-slate-400 text-sm">No sales orders found.</td></tr>
              ) : visible.map(order => (
                <tr key={order.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-indigo-600">{order.orderNo}</td>
                  <td className="px-4 py-3 text-sm text-slate-700">{order.customer?.name}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(order.date)}</td>
                  <td className="px-4 py-3 text-right text-sm font-semibold tabular">{formatOrderAmount(order, order.total)}</td>
                  <td className="px-4 py-3"><Badge status={order.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Sales Order" size="xl"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save Order</Button></>}>
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Select label="Customer" required value={form.customerId} onChange={e => setForm({ ...form, customerId: e.target.value })}>
              <option value="">Select customer...</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input label="Date" type="date" required value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <Select label="Currency" value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })}>
              {ALLOWED_CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
            </Select>
          </div>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead><tr className="bg-slate-50 border-b">{['Description', 'Account', 'Qty', 'Price', 'Tax %', ''].map(h => (
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
