'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { formatDate, formatCurrency as formatAmount } from '@/lib/utils'
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
interface Bill { id: string; billNo: string }
interface VendorCredit {
  id: string; creditNo: string; vendor?: { name: string }; bill?: { billNo: string }
  date: string; total: number; appliedAmount?: number; balance?: number; status: string; currency?: string; notes?: string
}

const STATUSES = ['OPEN', 'PARTIAL', 'CLOSED', 'VOID']

export default function VendorCreditsPage() {
  const formatPrimary = useFormatCurrency()
  const { currency: primaryCurrency } = useCompanyCurrency()
  const [credits, setCredits] = useState<VendorCredit[]>([])
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterValues>({ status: '', party: '', from: '', to: '', min: '', max: '' })
  const statusFilter = filters.status
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState({
    vendorId: '', billId: '', date: new Date().toISOString().split('T')[0],
    currency: 'SAR', subtotal: 0, taxAmount: 0, notes: '',
  })

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (statusFilter) params.set('status', statusFilter)
    const [cRes, vRes, bRes] = await Promise.all([
      fetch(`/api/vendor-credits?${params}`), fetch('/api/vendors'), fetch('/api/bills'),
    ])
    if (cRes.ok) setCredits(await cRes.json())
    if (vRes.ok) setVendors(await vRes.json())
    if (bRes.ok) setBills(await bRes.json())
    setLoading(false)
  }

  // The filter change is the external event that refreshes this server-backed list.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { load() }, [search, statusFilter])

  const total = Number(form.subtotal) + Number(form.taxAmount)
  const formatCreditAmount = (credit: VendorCredit, amount: number) => formatAmount(amount, credit.currency ?? primaryCurrency)

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/vendor-credits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, total }),
    })
    if (!res.ok) alert(await readApiError(res))
    else { setShowModal(false); load() }
    setSaving(false)
  }

  const visible = useMemo(() => credits.filter((r) => {
    if (filters.party && r.vendor?.name !== filters.party) return false
    const min = filters.min === '' ? null : Number(filters.min); const max = filters.max === '' ? null : Number(filters.max)
    if ((min !== null && r.total < min) || (max !== null && r.total > max)) return false
    return inDateRange(r.date, filters.from, filters.to)
  }), [credits, filters])
  const exportColumns: ExportColumn<VendorCredit>[] = [
    { header: 'Credit No', value: (r) => r.creditNo }, { header: 'Supplier', value: (r) => r.vendor?.name }, { header: 'Bill', value: (r) => r.bill?.billNo }, { header: 'Date', value: (r) => r.date, type: 'date' },
    { header: 'Currency', value: (r) => r.currency }, { header: 'Total', value: (r) => r.total, type: 'currency' }, { header: 'Applied', value: (r) => r.appliedAmount ?? 0, type: 'currency' },
    { header: 'Remaining', value: (r) => r.balance ?? 0, type: 'currency' }, { header: 'Status', value: (r) => r.status }, { header: 'Notes', value: (r) => r.notes },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Supplier Credits"
        subtitle={`${credits.length} credits · ${formatPrimary(credits.reduce((s, c) => s + c.total, 0))} total`}
        breadcrumb={[{ label: 'Expenses' }, { label: 'Supplier Credits' }]}
        action={<Button onClick={() => { setForm({ vendorId: '', billId: '', date: new Date().toISOString().split('T')[0], currency: primaryCurrency, subtotal: 0, taxAmount: 0, notes: '' }); setShowModal(true) }}><Plus size={15} /> New Credit</Button>}
      />

      <FilterBar>
        <SearchBar value={search} onChange={setSearch} placeholder="Search credit number..." className="flex-1 max-w-sm" />
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="vendor-credits" sheetName="Vendor Credits" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'party', label: 'Supplier', type: 'select', allLabel: 'All', options: vendors.map((x) => ({ value: x.name, label: x.name })) }, { key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: STATUSES.map((x) => ({ value: x, label: x })) }, { key: 'from', label: 'Date from', type: 'date' }, { key: 'to', label: 'Date to', type: 'date' }, { key: 'min', label: 'Min total', type: 'number' }, { key: 'max', label: 'Max total', type: 'number' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full data-table">
          <thead>
            <tr className="border-b border-slate-100">
              {['Credit #', 'Supplier', 'Bill', 'Date', 'Total', 'Applied', 'Remaining', 'Status'].map((h) => (
                <th key={h} className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-16 text-center text-slate-400 text-sm">No supplier credits found.</td></tr>
            ) : visible.map((credit) => (
              <tr key={credit.id} className="hover:bg-slate-50/60 transition-colors">
                <td className="px-4 py-3 font-mono text-xs font-semibold text-indigo-600">{credit.creditNo}</td>
                <td className="px-4 py-3 text-sm font-semibold text-slate-800">{credit.vendor?.name ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{credit.bill?.billNo ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{formatDate(credit.date)}</td>
                <td className="px-4 py-3 text-sm font-semibold text-emerald-600 tabular">{formatCreditAmount(credit, credit.total)}</td>
                <td className="px-4 py-3 text-sm tabular text-slate-600">{formatCreditAmount(credit, credit.appliedAmount ?? 0)}</td>
                <td className="px-4 py-3 text-sm font-semibold tabular text-indigo-600">{formatCreditAmount(credit, credit.balance ?? credit.total)}</td>
                <td className="px-4 py-3"><Badge status={credit.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Supplier Credit" size="md"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save Credit</Button></>}
      >
        <div className="space-y-4">
          <Select label="Supplier" required value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })}>
            <option value="">Select supplier...</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
          <Select label="Related Bill (optional)" value={form.billId} onChange={(e) => setForm({ ...form, billId: e.target.value })}>
            <option value="">—</option>
            {bills.map((b) => <option key={b.id} value={b.id}>{b.billNo}</option>)}
          </Select>
          <Input label="Date" type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <Select label="Currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            {ALLOWED_CURRENCIES.map((entry) => <option key={entry.code} value={entry.code}>{entry.code}</option>)}
          </Select>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Subtotal" type="number" min="0" value={form.subtotal} onChange={(e) => setForm({ ...form, subtotal: parseFloat(e.target.value) || 0 })} />
            <Input label="Tax Amount" type="number" min="0" value={form.taxAmount} onChange={(e) => setForm({ ...form, taxAmount: parseFloat(e.target.value) || 0 })} />
          </div>
          <p className="text-sm text-slate-600">Total: <span className="font-semibold">{formatAmount(total, form.currency)}</span></p>
          <Textarea label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
        </div>
      </Modal>
    </div>
  )
}
