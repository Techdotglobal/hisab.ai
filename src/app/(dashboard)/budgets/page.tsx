'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import { PageHeader, FilterBar } from '@/components/ui/page-header'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface Budget {
  id: string; name: string; fiscal_year: number; status: string
}

export default function BudgetsPage() {
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [filters, setFilters] = useState<FilterValues>({ status: '', year: '' })
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: '', fiscalYear: new Date().getFullYear(),
  })

  async function load() {
    setLoading(true)
    const res = await fetch('/api/budgets')
    if (res.ok) setBudgets(await res.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/budgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    if (!res.ok) alert(await readApiError(res))
    else { setShowModal(false); load() }
    setSaving(false)
  }

  const visible = useMemo(() => budgets.filter((b) => (!filters.status || b.status === filters.status) && (!filters.year || String(b.fiscal_year) === filters.year)), [budgets, filters])
  const exportColumns: ExportColumn<Budget>[] = [
    { header: 'Name', value: (b) => b.name }, { header: 'Fiscal Year', value: (b) => b.fiscal_year, type: 'number' }, { header: 'Status', value: (b) => b.status },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Budgets"
        subtitle={`${budgets.length} budgets`}
        breadcrumb={[{ label: 'Reports' }, { label: 'Budgets' }]}
        action={<Button onClick={() => setShowModal(true)}><Plus size={15} /> New Budget</Button>}
      />

      <FilterBar>
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:bg-slate-50 bg-white">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="budgets" sheetName="Budgets" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: [...new Set(budgets.map((b) => b.status))].sort().map((x) => ({ value: x, label: x })) }, { key: 'year', label: 'Fiscal year', type: 'select', allLabel: 'All years', options: [...new Set(budgets.map((b) => String(b.fiscal_year)))].sort().map((x) => ({ value: x, label: x })) }]} />

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full data-table">
          <thead>
            <tr className="border-b border-slate-100">
              {['Name', 'Fiscal Year', 'Status'].map(h => (
                <th key={h} className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {visible.map(b => (
              <tr key={b.id}>
                <td className="px-4 py-3 text-sm font-medium">{b.name}</td>
                <td className="px-4 py-3 text-sm tabular">{b.fiscal_year}</td>
                <td className="px-4 py-3"><Badge status={b.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Budget"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save</Button></>}
      >
        <div className="space-y-4">
          <Input label="Name" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <Input label="Fiscal Year" type="number" value={form.fiscalYear} onChange={e => setForm({ ...form, fiscalYear: parseInt(e.target.value) || new Date().getFullYear() })} />
        </div>
      </Modal>
    </div>
  )
}
