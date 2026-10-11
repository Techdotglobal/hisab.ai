'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Upload } from 'lucide-react'
import { formatDate, formatCurrency as formatAmount, cn } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { ALLOWED_CURRENCIES } from '@/lib/currency/constants'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select } from '@/components/ui/input'
import { PageHeader, SearchBar, FilterBar } from '@/components/ui/page-header'
import { CsvImportModal } from '@/components/ui/csv-import-modal'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface Account { id: string; accountNo: string; name: string }
interface Expense {
  id: string; expenseNo: string; date: string; description: string
  category: string; total: number; taxAmount: number; status: string; currency?: string
}

const CATEGORIES = ['Travel', 'Meals', 'Office Supplies', 'Utilities', 'Software', 'Equipment', 'Marketing', 'Other']
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAID']
const EMPTY_LINE = { description: '', amount: 0, taxRate: 0, accountId: '' }

export default function ExpensesPage() {
  const formatPrimary = useFormatCurrency()
  const { currency: primaryCurrency } = useCompanyCurrency()
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterValues>({ status: '', category: '', from: '', to: '', min: '', max: '' })
  const statusFilter = filters.status
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    date: new Date().toISOString().split('T')[0],
    description: '', category: 'Travel', currency: 'SAR',
    receiptId: '' as string,
    lines: [{ ...EMPTY_LINE }]
  })
  const [receiptUploading, setReceiptUploading] = useState(false)

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (statusFilter) params.set('status', statusFilter)
    const [eRes, aRes] = await Promise.all([fetch(`/api/expenses?${params}`), fetch('/api/accounts')])
    if (eRes.ok) setExpenses(await eRes.json())
    if (aRes.ok) setAccounts(await aRes.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [search, statusFilter])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const supplierName = params.get('supplierName')
    if (params.get('new') !== '1' || !supplierName) return
    const timer = window.setTimeout(() => {
      setForm({ date: new Date().toISOString().split('T')[0], description: `Supplier: ${supplierName}`, category: 'Travel', currency: params.get('currency') || primaryCurrency, receiptId: '', lines: [{ ...EMPTY_LINE }] })
      setShowModal(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [primaryCurrency])

  function updateLine(idx: number, field: string, value: string | number) {
    setForm(f => ({ ...f, lines: f.lines.map((l, i) => i === idx ? { ...l, [field]: value } : l) }))
  }

  const total = form.lines.reduce((s, l) => s + l.amount * (1 + l.taxRate / 100), 0)
  const formatFormAmount = (amount: number) => formatAmount(amount, form.currency)
  const formatExpenseAmount = (expense: Expense, amount: number) => formatAmount(amount, expense.currency ?? primaryCurrency)

  function openCreateExpense() {
    setForm({
      date: new Date().toISOString().split('T')[0],
      description: '', category: 'Travel', currency: primaryCurrency,
      receiptId: '',
      lines: [{ ...EMPTY_LINE }],
    })
    setShowModal(true)
  }

  async function handleReceiptUpload(file: File) {
    setReceiptUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('description', form.description || 'Expense receipt')
      const res = await fetch('/api/receipts', { method: 'POST', body: fd })
      if (!res.ok) {
        alert(await readApiError(res))
        return
      }
      const receipt = await res.json()
      setForm(f => ({ ...f, receiptId: receipt.id }))
    } finally {
      setReceiptUploading(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/expenses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    if (!res.ok) {
      alert(await readApiError(res))
      setSaving(false)
      return
    }
    if (res.ok) { setShowModal(false); load() }
    setSaving(false)
  }

  async function handleApprove(id: string) {
    const res = await fetch(`/api/expenses/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'APPROVED' }) })
    if (!res.ok) {
      alert(await readApiError(res))
      return
    }
    load()
  }

  const totalAmt = expenses.reduce((s, e) => s + e.total, 0)
  const pending = expenses.filter(e => e.status === 'PENDING').length

  const visible = useMemo(() => expenses.filter((e) => {
    if (filters.category && e.category !== filters.category) return false
    if (filters.min !== '' && e.total < Number(filters.min)) return false
    if (filters.max !== '' && e.total > Number(filters.max)) return false
    return inDateRange(e.date, filters.from, filters.to)
  }), [expenses, filters])
  const exportColumns: ExportColumn<Expense>[] = [
    { header: 'Expense No', value: (e) => e.expenseNo }, { header: 'Date', value: (e) => e.date, type: 'date' }, { header: 'Description', value: (e) => e.description },
    { header: 'Category', value: (e) => e.category }, { header: 'Currency', value: (e) => e.currency }, { header: 'Tax Amount', value: (e) => e.taxAmount, type: 'currency' },
    { header: 'Total', value: (e) => e.total, type: 'currency' }, { header: 'Status', value: (e) => e.status },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Expenses"
        subtitle={`${expenses.length} expenses · ${formatPrimary(totalAmt)} total · ${pending} pending`}
        breadcrumb={[{ label: 'Expenses' }, { label: 'Expenses' }]}
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setShowImport(true)}><Upload size={14} /> Import CSV</Button>
            <Button onClick={openCreateExpense}><Plus size={15} /> New Expense</Button>
          </div>
        }
      />

      <FilterBar>
        <SearchBar value={search} onChange={setSearch} placeholder="Search expenses..." className="flex-1 max-w-sm" />
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="expenses" sheetName="Expenses" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: STATUSES.map((x) => ({ value: x, label: x })) }, { key: 'category', label: 'Category', type: 'select', allLabel: 'All categories', options: CATEGORIES.map((x) => ({ value: x, label: x })) }, { key: 'from', label: 'Date from', type: 'date' }, { key: 'to', label: 'Date to', type: 'date' }, { key: 'min', label: 'Min total', type: 'number' }, { key: 'max', label: 'Max total', type: 'number' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['Expense #', 'Date', 'Description', 'Category', 'Amount', 'Status', ''].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left', h === 'Amount' && 'text-right', h === 'Status' && 'text-center', h === '' && 'w-24')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 7 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : visible.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-slate-400 text-sm">No expenses found.</td></tr>
              ) : visible.map(e => (
                <tr key={e.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-indigo-600">{e.expenseNo}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(e.date)}</td>
                  <td className="px-4 py-3 text-sm text-slate-700 max-w-[200px] truncate">{e.description}</td>
                  <td className="px-4 py-3"><span className="badge bg-slate-50 text-slate-600 border border-slate-200">{e.category}</span></td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-900 tabular text-sm">{formatExpenseAmount(e, e.total)}</td>
                  <td className="px-4 py-3 text-center"><Badge status={e.status} /></td>
                  <td className="px-4 py-3">
                    {e.status === 'PENDING' && (
                      <button onClick={() => handleApprove(e.id)} className="text-xs font-semibold text-emerald-600 hover:bg-emerald-50 px-2 py-1 rounded-lg transition-colors">Approve</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <CsvImportModal type="expenses" open={showImport} onClose={() => setShowImport(false)} onSuccess={load} />

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Expense" size="lg"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save Expense</Button></>}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Input label="Date" type="date" required value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
            <Select label="Category" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </Select>
            <Select label="Currency" required value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value })}>
              {ALLOWED_CURRENCIES.map((entry) => (
                <option key={entry.code} value={entry.code}>{entry.code} — {entry.name}</option>
              ))}
            </Select>
            <Input label="Description" required value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <p className="text-xs text-slate-400">
            Defaults to your company primary currency ({primaryCurrency}). Changing this affects only this expense.
          </p>
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Receipt</label>
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/*,.pdf"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleReceiptUpload(f) }}
                className="text-xs"
              />
              {receiptUploading && <span className="text-xs text-slate-400">Uploading...</span>}
              {form.receiptId && <span className="text-xs text-emerald-600 font-medium">Receipt attached</span>}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Line Items</label>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    {['Description', 'Account', 'Amount', 'Tax %', ''].map((h, i) => <th key={i} className="px-3 py-2.5 text-[10px] font-semibold text-slate-500 uppercase text-left">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {form.lines.map((line, idx) => (
                    <tr key={idx}>
                      <td className="px-2 py-2"><input value={line.description} onChange={e => updateLine(idx, 'description', e.target.value)} placeholder="Description" className="input-base text-xs py-1.5" /></td>
                      <td className="px-2 py-2 min-w-[120px]">
                        <select value={line.accountId} onChange={e => updateLine(idx, 'accountId', e.target.value)} className="input-base text-xs py-1.5 bg-white">
                          <option value="">—</option>
                          {accounts.filter(a => ['5', '6'].some(p => a.accountNo.startsWith(p))).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-2 w-32"><input type="number" min="0" value={line.amount} onChange={e => updateLine(idx, 'amount', parseFloat(e.target.value) || 0)} className="input-base text-xs py-1.5 text-right" /></td>
                      <td className="px-2 py-2 w-20"><input type="number" min="0" max="100" value={line.taxRate} onChange={e => updateLine(idx, 'taxRate', parseFloat(e.target.value) || 0)} className="input-base text-xs py-1.5 text-right" /></td>
                      <td className="px-2 py-2"><button onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }))} className="w-6 h-6 rounded-lg bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 flex items-center justify-center text-base">×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="bg-slate-50 border-t border-slate-200 px-4 py-2.5 flex justify-end">
                <span className="text-sm font-bold text-slate-800">Total: <span className="text-indigo-600 tabular">{formatFormAmount(total)}</span></span>
              </div>
            </div>
            <button onClick={() => setForm(f => ({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] }))} className="mt-2 flex items-center gap-1.5 text-sm text-indigo-600 font-medium"><Plus size={14} /> Add Line</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
