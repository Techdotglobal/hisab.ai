'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, CheckCircle } from 'lucide-react'
import { formatDate, cn } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select, Textarea } from '@/components/ui/input'
import { PageHeader, FilterBar } from '@/components/ui/page-header'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface Employee { id: string; name: string; salary: number; employeeNo: string }
interface PayrollEntry {
  id: string; payrollNo: string; employee: { name: string; employeeNo: string }
  period: string; basicSalary: number; allowances: number; deductions: number
  taxAmount: number; netSalary: number; status: string; paidAt?: string
}

export default function PayrollPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [payrolls, setPayrolls] = useState<PayrollEntry[]>([])
  const [filters, setFilters] = useState<FilterValues>({ employee: '', status: '', period: '', paidFrom: '', paidTo: '' })
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    employeeId: '', period: new Date().toISOString().slice(0, 7),
    allowances: 0, deductions: 0, taxRate: 0, notes: ''
  })

  async function load() {
    setLoading(true)
    const [pRes, eRes] = await Promise.all([fetch('/api/payroll'), fetch('/api/employees')])
    if (pRes.ok) setPayrolls(await pRes.json())
    if (eRes.ok) setEmployees(await eRes.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/payroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    if (!res.ok) {
      alert(await readApiError(res))
      setSaving(false)
      return
    }
    if (res.ok) { setShowModal(false); load() }
    setSaving(false)
  }

  async function handleApprove(id: string) {
    const res = await fetch(`/api/payroll/${id}/approve`, { method: 'POST' })
    if (!res.ok) {
      alert(await readApiError(res))
      return
    }
    load()
  }

  const selectedEmp = employees.find(e => e.id === form.employeeId)
  const basicSalary = selectedEmp?.salary || 0
  const taxAmount = (basicSalary + form.allowances - form.deductions) * (form.taxRate / 100)
  const net = basicSalary + form.allowances - form.deductions - taxAmount

  const totalPayroll = payrolls.filter(p => p.status === 'APPROVED' || p.status === 'PAID').reduce((s, p) => s + p.netSalary, 0)

  const payrollStatuses = useMemo(() => [...new Set(payrolls.map((p) => p.status))].sort(), [payrolls])
  const visible = useMemo(() => payrolls.filter((p) => {
    if (filters.employee && p.employee?.name !== filters.employee) return false
    if (filters.status && p.status !== filters.status) return false
    if (filters.period && !String(p.period ?? '').toLowerCase().includes(filters.period.toLowerCase())) return false
    return inDateRange(p.paidAt, filters.paidFrom, filters.paidTo)
  }), [payrolls, filters])
  const exportColumns: ExportColumn<PayrollEntry>[] = [
    { header: 'Payroll No', value: (p) => p.payrollNo }, { header: 'Employee No', value: (p) => p.employee?.employeeNo }, { header: 'Employee', value: (p) => p.employee?.name },
    { header: 'Period', value: (p) => p.period }, { header: 'Basic Salary', value: (p) => p.basicSalary, type: 'currency' }, { header: 'Allowances', value: (p) => p.allowances, type: 'currency' },
    { header: 'Deductions', value: (p) => p.deductions, type: 'currency' }, { header: 'Tax', value: (p) => p.taxAmount, type: 'currency' }, { header: 'Net Salary', value: (p) => p.netSalary, type: 'currency' },
    { header: 'Status', value: (p) => p.status }, { header: 'Paid On', value: (p) => p.paidAt, type: 'date' },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Payroll"
        subtitle={`${payrolls.length} payroll runs`}
        breadcrumb={[{ label: 'Operations' }, { label: 'Payroll' }]}
        action={<Button onClick={() => setShowModal(true)}><Plus size={15} /> Generate Payroll</Button>}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Payrolls', value: payrolls.length, color: 'text-slate-700' },
          { label: 'Draft', value: payrolls.filter(p => p.status === 'DRAFT').length, color: 'text-amber-600' },
          { label: 'Approved', value: payrolls.filter(p => p.status === 'APPROVED').length, color: 'text-indigo-600' },
          { label: 'Total Net Paid', value: formatCurrency(totalPayroll), color: 'text-emerald-600' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 px-4 py-3">
            <p className="text-xs text-slate-400 font-medium">{s.label}</p>
            <p className={cn('text-lg font-bold mt-0.5', s.color)}>{s.value}</p>
          </div>
        ))}
      </div>

      <FilterBar>
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="payroll" sheetName="Payroll" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'employee', label: 'Employee', type: 'select', allLabel: 'All employees', options: [...new Set(payrolls.map((p) => p.employee?.name).filter(Boolean))].sort().map((n) => ({ value: n, label: n })) }, { key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: payrollStatuses.map((x) => ({ value: x, label: x })) }, { key: 'period', label: 'Period contains', type: 'text', placeholder: 'e.g. 2026-03' }, { key: 'paidFrom', label: 'Paid from', type: 'date' }, { key: 'paidTo', label: 'Paid to', type: 'date' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['Payroll #', 'Employee', 'Period', 'Basic', 'Allowances', 'Deductions', 'Tax', 'Net Salary', 'Status', ''].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left',
                    ['Basic', 'Allowances', 'Deductions', 'Tax', 'Net Salary'].includes(h) && 'text-right',
                    h === 'Status' && 'text-center', h === '' && 'w-24')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 10 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : visible.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-16 text-center text-slate-400 text-sm">No payroll entries yet. Generate payroll for your employees.</td></tr>
              ) : visible.map(p => (
                <tr key={p.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-indigo-600 font-semibold">{p.payrollNo}</td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-800 text-sm">{p.employee.name}</p>
                    <p className="text-xs text-slate-400">{p.employee.employeeNo}</p>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-600">{p.period}</td>
                  <td className="px-4 py-3 text-right text-sm tabular">{formatCurrency(p.basicSalary)}</td>
                  <td className="px-4 py-3 text-right text-sm tabular text-emerald-600">{formatCurrency(p.allowances)}</td>
                  <td className="px-4 py-3 text-right text-sm tabular text-red-500">{formatCurrency(p.deductions)}</td>
                  <td className="px-4 py-3 text-right text-sm tabular text-slate-500">{formatCurrency(p.taxAmount)}</td>
                  <td className="px-4 py-3 text-right font-bold text-indigo-600 tabular">{formatCurrency(p.netSalary)}</td>
                  <td className="px-4 py-3 text-center"><Badge status={p.status} /></td>
                  <td className="px-4 py-3">
                    {p.status === 'DRAFT' && (
                      <button onClick={() => handleApprove(p.id)}
                        className="flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:bg-emerald-50 px-2 py-1 rounded-lg transition-colors">
                        <CheckCircle size={12} /> Approve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)}
        title="Generate Payroll" subtitle="Create payroll for an employee"
        size="sm"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Generate</Button></>}
      >
        <div className="space-y-4">
          <Select label="Employee" required value={form.employeeId} onChange={e => setForm({ ...form, employeeId: e.target.value })}>
            <option value="">Select employee...</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name} — {formatCurrency(e.salary)}/mo</option>)}
          </Select>
          <Input label="Period (YYYY-MM)" type="month" required value={form.period} onChange={e => setForm({ ...form, period: e.target.value })} />
          {selectedEmp && (
            <div className="bg-indigo-50 rounded-xl p-3 text-sm">
              <p className="text-slate-600">Basic Salary: <span className="font-bold text-indigo-700">{formatCurrency(basicSalary)}</span></p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label={`Allowances (${currency})`} type="number" value={form.allowances} onChange={e => setForm({ ...form, allowances: parseFloat(e.target.value) || 0 })} />
            <Input label={`Deductions (${currency})`} type="number" value={form.deductions} onChange={e => setForm({ ...form, deductions: parseFloat(e.target.value) || 0 })} />
          </div>
          <Input label="Tax Rate (%)" type="number" min="0" max="100" value={form.taxRate} onChange={e => setForm({ ...form, taxRate: parseFloat(e.target.value) || 0 })} />
          {selectedEmp && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
              <p className="text-sm font-semibold text-emerald-800">Net Salary: {formatCurrency(net)}</p>
              <p className="text-xs text-emerald-600 mt-0.5">Tax: {formatCurrency(taxAmount)}</p>
            </div>
          )}
          <Textarea label="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} />
        </div>
      </Modal>
    </div>
  )
}
