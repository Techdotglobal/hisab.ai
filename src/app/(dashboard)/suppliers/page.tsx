'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, Printer, RefreshCw, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { PageHeader, SearchBar, FilterBar } from '@/components/ui/page-header'
import { ActionDropdown } from '@/components/ui/action-dropdown'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { supplierTransactionHref } from '@/lib/supplier-navigation'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface Supplier { id: string; vendorNo: string; name: string; email?: string | null; phone?: string | null; address?: string | null; city?: string | null; paymentTerms: number; isActive: boolean; outstandingBalance?: number; createdAt?: string }
interface Bill { vendorId?: string; total: number; balance: number; status: string }
interface PurchaseOrder { vendorId?: string; total: number; status: string }

const emptyForm = { name: '', email: '', phone: '', address: '', city: '', country: 'Saudi Arabia', taxId: '', paymentTerms: 30 }

export default function SuppliersPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterValues>({ status: 'active', balance: '', city: '', createdFrom: '', createdTo: '' })
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [modal, setModal] = useState<'create' | 'edit' | null>(null)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [form, setForm] = useState(emptyForm)

  async function load() {
    setLoading(true)
    const [supplierRes, billRes, poRes] = await Promise.all([fetch('/api/vendors'), fetch('/api/bills'), fetch('/api/purchase-orders')])
    if (supplierRes.ok) setSuppliers(await supplierRes.json())
    if (billRes.ok) setBills(await billRes.json())
    if (poRes.ok) setOrders(await poRes.json())
    setLoading(false)
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const visible = useMemo(() => suppliers.filter((supplier) => {
    const matchesSearch = !search || [supplier.name, supplier.email, supplier.phone, supplier.vendorNo].filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase())
    const status = filters.status; const balance = filters.balance
    const matchesStatus = !status || status === 'all' || (status === 'active' ? supplier.isActive : !supplier.isActive)
    const matchesCity = !filters.city || (supplier.city ?? '').toLowerCase().includes(filters.city.toLowerCase())
    const matchesBalance = !balance || (balance === 'open' ? (supplier.outstandingBalance ?? 0) > 0 : (supplier.outstandingBalance ?? 0) === 0)
    return matchesSearch && matchesStatus && matchesBalance && matchesCity && inDateRange(supplier.createdAt, filters.createdFrom, filters.createdTo)
  }), [suppliers, search, filters])
  const exportColumns: ExportColumn<Supplier>[] = [
    { header: 'Supplier No', value: (s) => s.vendorNo }, { header: 'Name', value: (s) => s.name }, { header: 'Email', value: (s) => s.email }, { header: 'Phone', value: (s) => s.phone },
    { header: 'Address', value: (s) => s.address }, { header: 'City', value: (s) => s.city }, { header: 'Payment Terms (days)', value: (s) => s.paymentTerms, type: 'number' },
    { header: 'Status', value: (s) => s.isActive ? 'Active' : 'Inactive' }, { header: 'Open Balance', value: (s) => s.outstandingBalance ?? 0, type: 'currency' }, { header: 'Created', value: (s) => s.createdAt, type: 'date' },
  ]
  const perPage = 25
  const rows = visible.slice((page - 1) * perPage, page * perPage)
  const summary = useMemo(() => ({
    unbilled: orders.filter((order) => order.status === 'OPEN').reduce((total, order) => total + Number(order.total || 0), 0),
    unbilledCount: orders.filter((order) => order.status === 'OPEN').length,
    unpaid: bills.filter((bill) => bill.status !== 'PAID' && bill.balance > 0).reduce((total, bill) => total + Number(bill.balance || 0), 0),
    unpaidCount: bills.filter((bill) => bill.status !== 'PAID' && bill.balance > 0).length,
    open: bills.filter((bill) => bill.balance > 0).reduce((total, bill) => total + Number(bill.balance || 0), 0),
    openCount: bills.filter((bill) => bill.balance > 0).length,
    paid: bills.filter((bill) => bill.status === 'PAID').reduce((total, bill) => total + Number(bill.total || 0), 0),
    paidCount: bills.filter((bill) => bill.status === 'PAID').length,
  }), [bills, orders])

  function openCreate() { setEditing(null); setForm(emptyForm); setModal('create') }
  function openEdit(supplier: Supplier) { setEditing(supplier); setForm({ name: supplier.name, email: supplier.email ?? '', phone: supplier.phone ?? '', address: supplier.address ?? '', city: supplier.city ?? '', country: 'Saudi Arabia', taxId: '', paymentTerms: supplier.paymentTerms }); setModal('edit') }
  async function save() {
    setSaving(true)
    const response = await fetch(editing ? `/api/vendors/${editing.id}` : '/api/vendors', { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    if (!response.ok) alert(await readApiError(response)); else { setModal(null); await load() }
    setSaving(false)
  }
  async function setInactive(supplier: Supplier) {
    const response = await fetch(`/api/vendors/${supplier.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !supplier.isActive }) })
    if (!response.ok) alert(await readApiError(response)); else load()
  }
  function go(target: Parameters<typeof supplierTransactionHref>[0], supplier: Supplier) { window.location.assign(supplierTransactionHref(target, { ...supplier, currency })) }
  const toggle = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])

  return <div className="p-6 max-w-[1600px] mx-auto space-y-5">
    <PageHeader title="Suppliers" subtitle={`${visible.length} suppliers`} breadcrumb={[{ label: 'Expenses' }, { label: 'Suppliers' }]} action={<div className="flex gap-2"><Button variant="outline" onClick={() => window.print()}><Printer size={14} /> Print</Button><ExportMenu filename="suppliers" sheetName="Suppliers" columns={exportColumns} rows={visible} /><Button variant="outline" title="Supplier list settings are saved per browser"><Settings2 size={14} /> Settings</Button><Button onClick={openCreate}><Plus size={15} /> New Supplier</Button></div>} />
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {[['Unbilled POs', summary.unbilled, summary.unbilledCount, 'bg-sky-600'], ['Unpaid Bills', summary.unpaid, summary.unpaidCount, 'bg-amber-500'], ['Open Bills', summary.open, summary.openCount, 'bg-slate-600'], ['Paid Bills', summary.paid, summary.paidCount, 'bg-emerald-600']].map(([label, amount, count, color]) => <div key={String(label)} className={`${color} rounded-xl p-4 text-white`}><p className="text-xs font-semibold uppercase tracking-wide opacity-80">{label}</p><p className="mt-1 text-xl font-bold tabular">{formatCurrency(Number(amount))}</p><p className="text-xs opacity-85">{count} records</p></div>)}
    </div>
    <FilterBar><SearchBar value={search} onChange={(value) => { setSearch(value); setPage(1) }} placeholder="Search suppliers..." className="flex-1 max-w-sm" /><button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 bg-white"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button></FilterBar>
    <FilterPanel applied={filters} defaults={{ status: 'active' }} onApply={(v) => { setFilters(v); setPage(1) }} fields={[{ key: 'status', label: 'Status', type: 'select', allLabel: 'All suppliers', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] }, { key: 'balance', label: 'Balance', type: 'select', allLabel: 'Any balance', options: [{ value: 'open', label: 'Open balance' }, { value: 'zero', label: 'Zero balance' }] }, { key: 'city', label: 'City', type: 'text' }, { key: 'createdFrom', label: 'Created from', type: 'date' }, { key: 'createdTo', label: 'Created to', type: 'date' }]} />
    {selected.length > 0 && <p className="text-xs text-slate-500">{selected.length} supplier{selected.length === 1 ? '' : 's'} selected</p>}
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"><div className="overflow-x-auto"><table className="w-full data-table"><thead><tr className="border-b border-slate-100"><th className="px-3 py-3"><input type="checkbox" checked={rows.length > 0 && rows.every((row) => selected.includes(row.id))} onChange={() => setSelected(rows.every((row) => selected.includes(row.id)) ? [] : rows.map((row) => row.id))} /></th>{['Supplier', 'Company Name', 'Phone', 'Email', 'Open Balance', 'Action'].map((label) => <th key={label} className="px-4 py-3 text-left text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{label}</th>)}</tr></thead><tbody className="divide-y divide-slate-50">
      {loading ? Array.from({ length: 6 }).map((_, index) => <tr key={index}>{Array.from({ length: 7 }).map((__, cell) => <td key={cell} className="px-4 py-4"><div className="skeleton h-4 rounded" /></td>)}</tr>) : rows.length === 0 ? <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-slate-400">No suppliers match these filters.</td></tr> : rows.map((supplier) => <tr key={supplier.id} onClick={() => openEdit(supplier)} className="cursor-pointer hover:bg-slate-50/60"><td className="px-3 py-3" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected.includes(supplier.id)} onChange={() => toggle(supplier.id)} /></td><td className="px-4 py-3 font-medium text-indigo-600">{supplier.vendorNo}</td><td className="px-4 py-3 font-semibold text-slate-800">{supplier.name}<span className={`ml-2 badge ${supplier.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{supplier.isActive ? 'Active' : 'Inactive'}</span></td><td className="px-4 py-3 text-sm text-slate-600">{supplier.phone || '—'}</td><td className="px-4 py-3 text-sm text-slate-600">{supplier.email || '—'}</td><td className="px-4 py-3 text-sm font-semibold tabular text-rose-600">{formatCurrency(supplier.outstandingBalance ?? 0)}</td><td className="px-4 py-3"><ActionDropdown label="Create bill" items={[{ label: 'Create Bill', onSelect: () => go('bill', supplier) }, { label: 'Create Expense', onSelect: () => go('expense', supplier) }, { label: 'Create Cheque', onSelect: () => go('cheque', supplier) }, { label: 'Create Purchase Order', onSelect: () => go('purchase-order', supplier) }, { label: 'Item Receipt', onSelect: () => go('item-receipt', supplier) }, { label: supplier.isActive ? 'Make Inactive' : 'Make Active', onSelect: () => setInactive(supplier), danger: supplier.isActive }, { label: 'Edit Supplier', onSelect: () => openEdit(supplier) }]} /></td></tr>)}</tbody></table></div></div>
    <div className="flex items-center justify-between text-sm text-slate-500"><span>{visible.length ? `${(page - 1) * perPage + 1}–${Math.min(page * perPage, visible.length)} of ${visible.length}` : '0 suppliers'}</span><div className="flex gap-2"><Button variant="outline" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button variant="outline" disabled={page * perPage >= visible.length} onClick={() => setPage((value) => value + 1)}>Next</Button></div></div>
    <Modal open={modal !== null} onClose={() => setModal(null)} title={editing ? 'Edit Supplier' : 'New Supplier'} size="md" footer={<><Button variant="outline" onClick={() => setModal(null)}>Cancel</Button><Button onClick={save} loading={saving}>Save Supplier</Button></>}><div className="space-y-4"><Input label="Supplier / company name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><div className="grid grid-cols-2 gap-4"><Input label="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /><Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div><Input label="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /><div className="grid grid-cols-2 gap-4"><Input label="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /><Input label="Payment terms (days)" type="number" value={form.paymentTerms} onChange={(e) => setForm({ ...form, paymentTerms: Number(e.target.value) || 30 })} /></div></div></Modal>
  </div>
}
