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
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select, Textarea } from '@/components/ui/input'
import { PageHeader, SearchBar, FilterBar } from '@/components/ui/page-header'

interface Customer { id: string; name: string }
interface PaymentMethod { id: string; name: string }
interface Account { id: string; accountNo: string; name: string }
interface InventoryItem { id: string; name: string }
interface ReceiptLine { description: string; quantity: number; unitPrice: number; taxRate: number; accountId: string; inventoryItemId: string }
interface SalesReceipt {
  id: string; receiptNo: string; customer?: { name: string }; date: string
  total: number; paymentMethod: string; currency?: string
}

const EMPTY_LINE: ReceiptLine = { description: '', quantity: 1, unitPrice: 0, taxRate: 15, accountId: '', inventoryItemId: '' }

export default function SalesReceiptsPage() {
  const formatPrimary = useFormatCurrency()
  const { currency: primaryCurrency } = useCompanyCurrency()
  const [receipts, setReceipts] = useState<SalesReceipt[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [items, setItems] = useState<InventoryItem[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterValues>({ status: '', party: '', from: '', to: '', min: '', max: '' })
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState({
    customerId: '', date: new Date().toISOString().split('T')[0],
    notes: '', currency: primaryCurrency, paymentMethodId: '', depositAccountId: '',
    lines: [{ ...EMPTY_LINE }],
  })

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    const [recRes, custRes, methodRes, accountRes, itemRes] = await Promise.all([
      fetch(`/api/sales-receipts?${params}`),
      fetch('/api/customers'),
      fetch('/api/product-master/payment-methods'),
      fetch('/api/accounts'),
      fetch('/api/inventory'),
    ])
    if (recRes.ok) setReceipts(await recRes.json())
    if (custRes.ok) setCustomers(await custRes.json())
    if (methodRes.ok) {
      const methods = await methodRes.json()
      setPaymentMethods(methods)
      setForm(current => current.paymentMethodId || methods.length === 0 ? current : { ...current, paymentMethodId: methods[0].id })
    }
    if(accountRes.ok)setAccounts(await accountRes.json())
    if(itemRes.ok)setItems(await itemRes.json())
    setLoading(false)
  }

  // Search is the intentional reload boundary for this client-side list.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [search])

  function updateLine(idx: number, field: string, value: string | number) {
    setForm(f => ({ ...f, lines: f.lines.map((l, i) => i === idx ? { ...l, [field]: value } : l) }))
  }

  const total = form.lines.reduce((s, l) => s + l.quantity * l.unitPrice * (1 + l.taxRate / 100), 0)
  const formatFormAmount = (amount: number) => formatAmount(amount, form.currency)
  const formatReceiptAmount = (receipt: SalesReceipt, amount: number) => formatAmount(amount, receipt.currency ?? primaryCurrency)

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/sales-receipts', {
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

  const visible = useMemo(() => receipts.filter((r) => {
    if (filters.party && r.customer?.name !== filters.party) return false
    const min = filters.min === '' ? null : Number(filters.min); const max = filters.max === '' ? null : Number(filters.max)
    if ((min !== null && r.total < min) || (max !== null && r.total > max)) return false
    return inDateRange(r.date, filters.from, filters.to)
  }), [receipts, filters])
  const exportColumns: ExportColumn<SalesReceipt>[] = [
    { header: 'Receipt No', value: (r) => r.receiptNo }, { header: 'Customer', value: (r) => r.customer?.name }, { header: 'Date', value: (r) => r.date, type: 'date' },
    { header: 'Payment Method', value: (r) => r.paymentMethod }, { header: 'Currency', value: (r) => r.currency }, { header: 'Total', value: (r) => r.total, type: 'currency' },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Sales Receipts"
        subtitle={`${receipts.length} receipts · ${formatPrimary(receipts.reduce((s, r) => s + r.total, 0))} total`}
        breadcrumb={[{ label: 'Income' }, { label: 'Sales Receipts' }]}
        action={<Button onClick={() => setShowModal(true)}><Plus size={15} /> New Receipt</Button>}
      />

      <FilterBar>
        <SearchBar value={search} onChange={setSearch} placeholder="Search receipts..." className="flex-1 max-w-sm" />
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="sales-receipts" sheetName="Sales Receipts" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'party', label: 'Customer', type: 'select', allLabel: 'All', options: customers.map((x) => ({ value: x.name, label: x.name })) }, { key: 'from', label: 'Date from', type: 'date' }, { key: 'to', label: 'Date to', type: 'date' }, { key: 'min', label: 'Min total', type: 'number' }, { key: 'max', label: 'Max total', type: 'number' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['Receipt #', 'Customer', 'Date', 'Method', 'Total'].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left', h === 'Total' && 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 5 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : visible.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-16 text-center text-slate-400 text-sm">No sales receipts found.</td></tr>
              ) : visible.map(receipt => (
                <tr key={receipt.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-indigo-600">{receipt.receiptNo}</td>
                  <td className="px-4 py-3 text-sm text-slate-700">{receipt.customer?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(receipt.date)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{receipt.paymentMethod}</td>
                  <td className="px-4 py-3 text-right text-sm font-semibold tabular">{formatReceiptAmount(receipt, receipt.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Sales Receipt" size="lg"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save Receipt</Button></>}>
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select label="Customer" value={form.customerId} onChange={e => setForm({ ...form, customerId: e.target.value })}>
              <option value="">Walk-in / No customer</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input label="Date" type="date" required value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <Select label="Currency" value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })}>
              {ALLOWED_CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
            </Select>
            <Select label="Payment Method" required value={form.paymentMethodId} onChange={e => setForm({ ...form, paymentMethodId: e.target.value })}>
              <option value="">Select payment method</option>
              {paymentMethods.map(method => <option key={method.id} value={method.id}>{method.name}</option>)}
            </Select>
            <Select label="Deposit account" required value={form.depositAccountId} onChange={e => setForm({ ...form, depositAccountId: e.target.value })}>
              <option value="">Select bank or Undeposited Funds</option>
              {accounts.map(account=><option key={account.id} value={account.id}>{account.accountNo} · {account.name}</option>)}
            </Select>
          </div>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead><tr className="bg-slate-50 border-b">{['Item', 'Description', 'Revenue account', 'Qty', 'Price', 'Tax %', ''].map(h => (
                <th key={h} className="px-3 py-2 text-[10px] font-semibold text-slate-500 uppercase text-left">{h}</th>
              ))}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {form.lines.map((line, idx) => (
                  <tr key={idx}>
                    <td className="px-2 py-2"><select value={line.inventoryItemId} onChange={e=>updateLine(idx,'inventoryItemId',e.target.value)} className="input-base text-xs py-1.5"><option value="">Service / non-inventory</option>{items.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
                    <td className="px-2 py-2"><input value={line.description} onChange={e => updateLine(idx, 'description', e.target.value)} className="input-base text-xs py-1.5" /></td>
                    <td className="px-2 py-2"><select required value={line.accountId} onChange={e=>updateLine(idx,'accountId',e.target.value)} className="input-base text-xs py-1.5"><option value="">Select revenue</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.accountNo} · {account.name}</option>)}</select></td>
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
