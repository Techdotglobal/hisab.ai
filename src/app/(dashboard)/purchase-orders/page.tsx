'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, FileInput } from 'lucide-react'
import { formatDate, formatCurrency as formatAmount, cn } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { ALLOWED_CURRENCIES } from '@/lib/currency/constants'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select, Textarea } from '@/components/ui/input'
import { PageHeader, SearchBar, FilterBar } from '@/components/ui/page-header'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface Vendor { id: string; name: string }
interface Account { id: string; accountNo: string; name: string }
interface POLine { description: string; quantity: number; unitPrice: number; taxRate: number; accountId?: string }
interface PurchaseOrder {
  id: string; poNo: string; vendor?: { name: string }; date: string; expectedDate?: string
  total: number; status: string; currency?: string
}

const EMPTY_LINE: POLine = { description: '', quantity: 1, unitPrice: 0, taxRate: 15, accountId: '' }
const STATUSES = ['OPEN', 'CONVERTED', 'CANCELLED']

export default function PurchaseOrdersPage() {
  const formatPrimary = useFormatCurrency()
  const { currency: primaryCurrency } = useCompanyCurrency()
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterValues>({ status: '', party: '', from: '', to: '', min: '', max: '' })
  const statusFilter = filters.status
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [convertingId, setConvertingId] = useState<string | null>(null)

  const [form, setForm] = useState({
    vendorId: '', date: new Date().toISOString().split('T')[0],
    expectedDate: '', notes: '', currency: 'SAR', status: 'OPEN', email: '', mailingAddress: '', shipVia: '', supplierMessage: '',
    lines: [{ ...EMPTY_LINE }],
  })

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (statusFilter) params.set('status', statusFilter)
    const [poRes, vRes, aRes] = await Promise.all([
      fetch(`/api/purchase-orders?${params}`), fetch('/api/vendors'), fetch('/api/accounts'),
    ])
    if (poRes.ok) setOrders(await poRes.json())
    if (vRes.ok) setVendors(await vRes.json())
    if (aRes.ok) setAccounts(await aRes.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [search, statusFilter])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const supplierId = params.get('supplierId')
    if (params.get('new') !== '1' || !supplierId || !vendors.some((vendor) => vendor.id === supplierId)) return
    const timer = window.setTimeout(() => {
      setForm({ vendorId: supplierId, date: new Date().toISOString().split('T')[0], expectedDate: '', notes: '', currency: params.get('currency') || primaryCurrency, status: 'OPEN', email: '', mailingAddress: '', shipVia: '', supplierMessage: '', lines: [{ ...EMPTY_LINE }] })
      setShowModal(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [vendors, primaryCurrency])

  function updateLine(idx: number, field: string, value: string | number) {
    setForm((f) => ({ ...f, lines: f.lines.map((l, i) => (i === idx ? { ...l, [field]: value } : l)) }))
  }

  const subtotal = form.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
  const taxAmount = form.lines.reduce((s, l) => s + l.quantity * l.unitPrice * (l.taxRate / 100), 0)
  const total = subtotal + taxAmount
  const formatFormAmount = (amount: number) => formatAmount(amount, form.currency)
  const formatPoAmount = (po: PurchaseOrder, amount: number) => formatAmount(amount, po.currency ?? primaryCurrency)

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/purchase-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    })
    if (!res.ok) alert(await readApiError(res))
    else { setShowModal(false); load() }
    setSaving(false)
  }

  async function handleConvert(id: string) {
    if (!confirm('Convert this purchase order to a bill?')) return
    setConvertingId(id)
    const res = await fetch(`/api/purchase-orders/${id}/convert`, { method: 'POST' })
    if (!res.ok) alert(await readApiError(res))
    else load()
    setConvertingId(null)
  }

  const visible = useMemo(() => orders.filter((r) => {
    if (filters.party && r.vendor?.name !== filters.party) return false
    const min = filters.min === '' ? null : Number(filters.min); const max = filters.max === '' ? null : Number(filters.max)
    if ((min !== null && r.total < min) || (max !== null && r.total > max)) return false
    return inDateRange(r.date, filters.from, filters.to)
  }), [orders, filters])
  const exportColumns: ExportColumn<PurchaseOrder>[] = [
    { header: 'PO No', value: (r) => r.poNo }, { header: 'Supplier', value: (r) => r.vendor?.name }, { header: 'Date', value: (r) => r.date, type: 'date' },
    { header: 'Expected Date', value: (r) => r.expectedDate, type: 'date' }, { header: 'Currency', value: (r) => r.currency }, { header: 'Total', value: (r) => r.total, type: 'currency' }, { header: 'Status', value: (r) => r.status },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Purchase Orders"
        subtitle={`${orders.length} orders · ${formatPrimary(orders.reduce((s, o) => s + o.total, 0))} total`}
        breadcrumb={[{ label: 'Expenses' }, { label: 'Purchase Orders' }]}
        action={<Button onClick={() => { setForm({ vendorId: '', date: new Date().toISOString().split('T')[0], expectedDate: '', notes: '', currency: primaryCurrency, status: 'OPEN', email: '', mailingAddress: '', shipVia: '', supplierMessage: '', lines: [{ ...EMPTY_LINE }] }); setShowModal(true) }}><Plus size={15} /> New PO</Button>}
      />

      <FilterBar>
        <SearchBar value={search} onChange={setSearch} placeholder="Search PO number..." className="flex-1 max-w-sm" />
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="purchase-orders" sheetName="Purchase Orders" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'party', label: 'Supplier', type: 'select', allLabel: 'All', options: vendors.map((x) => ({ value: x.name, label: x.name })) }, { key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: STATUSES.map((x) => ({ value: x, label: x })) }, { key: 'from', label: 'Date from', type: 'date' }, { key: 'to', label: 'Date to', type: 'date' }, { key: 'min', label: 'Min total', type: 'number' }, { key: 'max', label: 'Max total', type: 'number' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['PO #', 'Supplier', 'Date', 'Expected', 'Total', 'Status', ''].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left', h === 'Total' && 'text-right', h === 'Status' && 'text-center', h === '' && 'w-28')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 7 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : visible.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-slate-400 text-sm">No purchase orders found.</td></tr>
              ) : visible.map((po) => (
                <tr key={po.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-indigo-600">{po.poNo}</td>
                  <td className="px-4 py-3 font-semibold text-slate-800 text-sm">{po.vendor?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(po.date)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{po.expectedDate ? formatDate(po.expectedDate) : '—'}</td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-900 tabular text-sm">{formatPoAmount(po, po.total)}</td>
                  <td className="px-4 py-3 text-center"><Badge status={po.status} /></td>
                  <td className="px-4 py-3">
                    {po.status === 'OPEN' && (
                      <button onClick={() => handleConvert(po.id)} disabled={convertingId === po.id}
                        className="flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded-lg transition-colors disabled:opacity-50">
                        <FileInput size={10} /> {convertingId === po.id ? 'Converting...' : 'To Bill'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="Purchase Order" subtitle="Create a purchase order for a supplier" size="xl"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button variant="outline" onClick={() => window.print()}>Print</Button><Button variant="outline" onClick={() => window.location.assign(`/recurring-transactions?new=1&transactionType=PURCHASE_ORDER&supplierId=${form.vendorId}`)}>Make Recurring</Button><Button onClick={handleSave} loading={saving}>Save & Close</Button></>}
      >
        <div className="space-y-5">
          <div className="flex items-start justify-between rounded-xl bg-slate-50 px-4 py-3"><div><p className="text-xs font-semibold uppercase text-slate-500">Purchase order total</p><p className="text-xl font-bold text-indigo-600">{formatFormAmount(total)}</p></div><Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-44"><option value="OPEN">Open</option><option value="PENDING_APPROVAL">Pending Approval</option><option value="APPROVED">Approved</option><option value="CLOSED">Closed</option><option value="CANCELLED">Cancelled</option></Select></div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Select label="Supplier" required value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })}>
              <option value="">Select supplier...</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </Select>
            <Input label="PO Date" type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <Input label="Expected Date" type="date" value={form.expectedDate} onChange={(e) => setForm({ ...form, expectedDate: e.target.value })} />
            <Select label="Currency" required value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              {ALLOWED_CURRENCIES.map((entry) => <option key={entry.code} value={entry.code}>{entry.code} — {entry.name}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4"><Input label="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="supplier@example.com, accounts@example.com" /><Input label="Ship Via" value={form.shipVia} onChange={(e) => setForm({ ...form, shipVia: e.target.value })} placeholder="Courier, air, sea..." /><Input label="Mailing Address" value={form.mailingAddress} onChange={(e) => setForm({ ...form, mailingAddress: e.target.value })} placeholder="Supplier address" /></div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Line Items</label>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    {['Description', 'Account', 'Qty', 'Unit Price', 'Tax %', 'Amount', ''].map((h, i) => (
                      <th key={i} className="px-3 py-2.5 text-[10px] font-semibold text-slate-500 uppercase text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {form.lines.map((line, idx) => (
                    <tr key={idx}>
                      <td className="px-2 py-2"><input value={line.description} onChange={(e) => updateLine(idx, 'description', e.target.value)} placeholder="Description" className="input-base text-xs py-1.5" /></td>
                      <td className="px-2 py-2 min-w-[120px]">
                        <select value={line.accountId} onChange={(e) => updateLine(idx, 'accountId', e.target.value)} className="input-base text-xs py-1.5 bg-white">
                          <option value="">—</option>
                          {accounts.filter((a) => ['5', '6'].some((p) => a.accountNo.startsWith(p))).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-2 w-20"><input type="number" min="0" value={line.quantity} onChange={(e) => updateLine(idx, 'quantity', parseFloat(e.target.value) || 0)} className="input-base text-xs py-1.5 text-right" /></td>
                      <td className="px-2 py-2 w-28"><input type="number" min="0" value={line.unitPrice} onChange={(e) => updateLine(idx, 'unitPrice', parseFloat(e.target.value) || 0)} className="input-base text-xs py-1.5 text-right" /></td>
                      <td className="px-2 py-2 w-20"><input type="number" min="0" max="100" value={line.taxRate} onChange={(e) => updateLine(idx, 'taxRate', parseFloat(e.target.value) || 0)} className="input-base text-xs py-1.5 text-right" /></td>
                      <td className="px-3 py-2 text-right text-sm font-semibold text-slate-700 tabular whitespace-nowrap">{formatFormAmount(line.quantity * line.unitPrice * (1 + line.taxRate / 100))}</td>
                      <td className="px-2 py-2 text-center"><button onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }))} className="w-6 h-6 rounded-lg bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 flex items-center justify-center text-base">×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="bg-slate-50 border-t border-slate-200 px-4 py-3 flex flex-col items-end gap-1">
                <div className="flex gap-8 text-base font-bold"><span className="text-slate-800">Total:</span><span className="text-indigo-600 tabular w-28 text-right">{formatFormAmount(total)}</span></div>
              </div>
            </div>
            <button onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] }))} className="mt-2 flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium">
              <Plus size={14} /> Add Line
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><Textarea label="Your Message to Supplier" value={form.supplierMessage} onChange={(e) => setForm({ ...form, supplierMessage: e.target.value })} rows={3} /><Textarea label="Memo" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} /></div>
        </div>
      </Modal>
    </div>
  )
}
