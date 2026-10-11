'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Edit2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select } from '@/components/ui/input'
import { PageHeader, SearchBar, FilterBar } from '@/components/ui/page-header'
import { ModuleImportExportToolbar } from '@/components/import-export/ModuleImportExportToolbar'
import { ACCOUNT_FIELDS } from '@/lib/import-export/registry/modules/accounts.fields'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface Account {
  id: string; accountNo: string; fullName: string; name: string
  parentNo: string | null; accountType: string; subType: string; isActive: boolean; balance: number
}

const ACCOUNT_TYPES = [
  'Bank', 'Accounts receivable (A/R)', 'Other Current Assets', 'Other Assets',
  'Accounts payable (A/P)', 'Other Current Liabilities', 'Long Term Liabilities',
  'Equity', 'Income', 'Cost of Goods Sold', 'Expenses',
]

const TYPE_COLORS: Record<string, string> = {
  'Bank': 'bg-sky-50 text-sky-700 border border-sky-200',
  'Accounts receivable (A/R)': 'bg-blue-50 text-blue-700 border border-blue-200',
  'Other Current Assets': 'bg-indigo-50 text-indigo-700 border border-indigo-200',
  'Accounts payable (A/P)': 'bg-orange-50 text-orange-700 border border-orange-200',
  'Other Current Liabilities': 'bg-amber-50 text-amber-700 border border-amber-200',
  'Long Term Liabilities': 'bg-red-50 text-red-700 border border-red-200',
  'Equity': 'bg-violet-50 text-violet-700 border border-violet-200',
  'Income': 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  'Cost of Goods Sold': 'bg-yellow-50 text-yellow-700 border border-yellow-200',
  'Expenses': 'bg-rose-50 text-rose-700 border border-rose-200',
  'Other Assets': 'bg-slate-50 text-slate-600 border border-slate-200',
}

export default function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterValues>({ type: '', status: '', balance: '' })
  const typeFilter = filters.type
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Account | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    accountNo: '', name: '', fullName: '', parentNo: '',
    accountType: 'Expenses', subType: '', description: ''
  })

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (typeFilter) params.set('type', typeFilter)
    const res = await fetch(`/api/accounts?${params}`)
    if (res.ok) setAccounts(await res.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [search, typeFilter])

  const visible = useMemo(() => accounts.filter((a) => {
    if (filters.status === 'active' && !a.isActive) return false
    if (filters.status === 'inactive' && a.isActive) return false
    if (filters.balance === 'nonzero' && !Number(a.balance)) return false
    if (filters.balance === 'zero' && Number(a.balance)) return false
    return true
  }), [accounts, filters.status, filters.balance])
  const exportColumns: ExportColumn<Account>[] = [
    { header: 'Account No', value: (a) => a.accountNo }, { header: 'Name', value: (a) => a.name }, { header: 'Full Name', value: (a) => a.fullName },
    { header: 'Parent No', value: (a) => a.parentNo }, { header: 'Account Type', value: (a) => a.accountType }, { header: 'Sub Type', value: (a) => a.subType },
    { header: 'Status', value: (a) => a.isActive ? 'Active' : 'Inactive' }, { header: 'Balance', value: (a) => a.balance, type: 'currency' },
  ]

  function openCreate() {
    setEditing(null)
    setForm({ accountNo: '', name: '', fullName: '', parentNo: '', accountType: 'Expenses', subType: '', description: '' })
    setShowModal(true)
  }

  function openEdit(acc: Account) {
    setEditing(acc)
    setForm({ accountNo: acc.accountNo, name: acc.name, fullName: acc.fullName, parentNo: acc.parentNo || '', accountType: acc.accountType, subType: acc.subType, description: '' })
    setShowModal(true)
  }

  async function handleSave() {
    setSaving(true)
    const url = editing ? `/api/accounts/${editing.id}` : '/api/accounts'
    const res = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    if (!res.ok) {
      alert(await readApiError(res))
      setSaving(false)
      return
    }
    if (res.ok) { setShowModal(false); load() }
    setSaving(false)
  }

  function getLevel(accountNo: string) {
    const dashes = (accountNo.match(/-/g) || []).length
    return dashes
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Chart of Accounts"
        subtitle={`${visible.length} accounts`}
        breadcrumb={[{ label: 'Accounting' }, { label: 'Chart of Accounts' }]}
        action={(
          <div className="flex items-center gap-2">
            <ModuleImportExportToolbar
              moduleKey="accounts"
              moduleLabel="Chart of Accounts"
              fields={ACCOUNT_FIELDS}
              filters={{
                ...(search ? { search } : {}),
                ...(typeFilter ? { type: typeFilter } : {}),
              }}
              onImportSuccess={load}
              tableExport={{ filename: 'chart-of-accounts', columns: exportColumns, rows: visible }}
            />
            <Button onClick={openCreate}><Plus size={15} /> Add Account</Button>
          </div>
        )}
      />

      <FilterBar>
        <SearchBar value={search} onChange={setSearch} placeholder="Search by code or name..." className="flex-1 max-w-sm" />
        <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'type', label: 'Account type', type: 'select', allLabel: 'All types', options: ACCOUNT_TYPES.map((t) => ({ value: t, label: t })) }, { key: 'status', label: 'Status', type: 'select', allLabel: 'Active & inactive', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] }, { key: 'balance', label: 'Balance', type: 'select', allLabel: 'Any balance', options: [{ value: 'nonzero', label: 'Non-zero' }, { value: 'zero', label: 'Zero' }] }]} />
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </FilterBar>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['Account No.', 'Name', 'Type', 'Sub Type', 'Balance', 'Status', ''].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left',
                    h === 'Balance' && 'text-right', h === 'Status' && 'text-center', h === '' && 'w-16')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 7 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <p className="text-slate-400 text-sm">No accounts found.</p>
                    </div>
                  </td>
                </tr>
              ) : visible.map((acc) => {
                const level = getLevel(acc.accountNo)
                const isParent = level === 0
                return (
                  <tr key={acc.id} className={cn('hover:bg-slate-50/60 transition-colors', isParent && 'bg-slate-50/40')}>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{acc.accountNo}</td>
                    <td className="px-4 py-2.5">
                      <span style={{ paddingLeft: level * 16 }}
                        className={cn('text-sm', isParent ? 'font-bold text-slate-900' : 'text-slate-700')}>
                        {acc.name}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={cn('badge text-[10px]', TYPE_COLORS[acc.accountType] || 'bg-slate-50 text-slate-600 border border-slate-200')}>
                        {acc.accountType.replace('Accounts receivable (A/R)', 'AR').replace('Accounts payable (A/P)', 'AP')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-400 max-w-[180px] truncate">{acc.subType}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-sm font-medium text-slate-800 tabular">
                      {acc.balance !== 0 ? acc.balance.toLocaleString('en-SA', { minimumFractionDigits: 2 }) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <span className={cn('badge', acc.isActive ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-50 text-gray-500 border border-gray-200')}>
                        {acc.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <button onClick={() => openEdit(acc)} className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"><Edit2 size={13} /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)}
        title={editing ? 'Edit Account' : 'New Account'} subtitle="Chart of Accounts entry" size="md"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save Account</Button></>}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input label="Account No." required value={form.accountNo} onChange={e => setForm({ ...form, accountNo: e.target.value })} disabled={!!editing} placeholder="32-3201" />
            <Input label="Parent Account No." value={form.parentNo} onChange={e => setForm({ ...form, parentNo: e.target.value })} placeholder="32" />
          </div>
          <Input label="Name" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Short name" />
          <Input label="Full Name" value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} placeholder="Full hierarchical name" />
          <div className="grid grid-cols-2 gap-4">
            <Select label="Account Type" value={form.accountType} onChange={e => setForm({ ...form, accountType: e.target.value })}>
              {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </Select>
            <Input label="Sub Type" value={form.subType} onChange={e => setForm({ ...form, subType: e.target.value })} />
          </div>
          <Input label="Description" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
        </div>
      </Modal>
    </div>
  )
}
