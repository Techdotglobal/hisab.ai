'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { formatDate, formatCurrency as formatAmount } from '@/lib/utils'
import { useCompanyCurrency } from '@/hooks/use-company-currency'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select } from '@/components/ui/input'
import { PageHeader, FilterBar } from '@/components/ui/page-header'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface Employee { id: string; name: string }
interface Claim {
  id: string; claim_no: string; employee_id: string; date: string
  status: string; total: number; notes?: string
}

export default function ExpenseClaimsPage() {
  const { currency: primaryCurrency } = useCompanyCurrency()
  const [claims, setClaims] = useState<Claim[]>([])
  const [filters, setFilters] = useState<FilterValues>({ employee: '', status: '', from: '', to: '', min: '', max: '' })
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    employeeId: '', date: new Date().toISOString().split('T')[0], total: 0, notes: '',
  })

  async function load() {
    setLoading(true)
    const [cRes, eRes] = await Promise.all([fetch('/api/expense-claims'), fetch('/api/employees')])
    if (cRes.ok) setClaims(await cRes.json())
    if (eRes.ok) setEmployees(await eRes.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/expense-claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    if (!res.ok) alert(await readApiError(res))
    else { setShowModal(false); load() }
    setSaving(false)
  }

  const employeeName = (id: string) => employees.find(e => e.id === id)?.name ?? id.slice(0, 8)

  const claimStatuses = useMemo(() => [...new Set(claims.map((c) => c.status))].sort(), [claims])
  const visible = useMemo(() => claims.filter((c) => {
    if (filters.employee && c.employee_id !== filters.employee) return false
    if (filters.status && c.status !== filters.status) return false
    if (filters.min !== '' && c.total < Number(filters.min)) return false
    if (filters.max !== '' && c.total > Number(filters.max)) return false
    return inDateRange(c.date, filters.from, filters.to)
  }), [claims, filters])
  const exportColumns: ExportColumn<Claim>[] = [
    { header: 'Claim No', value: (c) => c.claim_no }, { header: 'Employee', value: (c) => employees.find((e) => e.id === c.employee_id)?.name ?? c.employee_id },
    { header: 'Date', value: (c) => c.date, type: 'date' }, { header: 'Amount', value: (c) => c.total, type: 'currency' }, { header: 'Status', value: (c) => c.status }, { header: 'Notes', value: (c) => c.notes },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Expense Claims"
        subtitle={`${claims.length} claims`}
        breadcrumb={[{ label: 'Expenses' }, { label: 'Claims' }]}
        action={<Button onClick={() => setShowModal(true)}><Plus size={15} /> New Claim</Button>}
      />

      <FilterBar>
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 bg-white">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="expense-claims" sheetName="Expense Claims" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'employee', label: 'Employee', type: 'select', allLabel: 'All employees', options: employees.map((e) => ({ value: e.id, label: e.name })) }, { key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: claimStatuses.map((x) => ({ value: x, label: x })) }, { key: 'from', label: 'Date from', type: 'date' }, { key: 'to', label: 'Date to', type: 'date' }, { key: 'min', label: 'Min amount', type: 'number' }, { key: 'max', label: 'Max amount', type: 'number' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full data-table">
          <thead>
            <tr className="border-b border-slate-100">
              {['Claim #', 'Employee', 'Date', 'Amount', 'Status', 'Notes'].map(h => (
                <th key={h} className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-16 text-center text-slate-400">No claims yet.</td></tr>
            ) : visible.map(c => (
              <tr key={c.id} className="hover:bg-slate-50/60">
                <td className="px-4 py-3 font-mono text-xs text-indigo-600">{c.claim_no}</td>
                <td className="px-4 py-3 text-sm">{employeeName(c.employee_id)}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{formatDate(c.date)}</td>
                <td className="px-4 py-3 text-sm font-semibold tabular">{formatAmount(Number(c.total), primaryCurrency)}</td>
                <td className="px-4 py-3"><Badge status={c.status} /></td>
                <td className="px-4 py-3 text-xs text-slate-500 truncate max-w-[200px]">{c.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Expense Claim"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save</Button></>}
      >
        <div className="space-y-4">
          <Select label="Employee" required value={form.employeeId} onChange={e => setForm({ ...form, employeeId: e.target.value })}>
            <option value="">Select employee</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
          <Input label="Date" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
          <Input label="Total" type="number" min="0" value={form.total} onChange={e => setForm({ ...form, total: parseFloat(e.target.value) || 0 })} />
          <Input label="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
      </Modal>
    </div>
  )
}
