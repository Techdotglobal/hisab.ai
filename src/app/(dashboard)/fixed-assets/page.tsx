'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { formatDate, formatCurrency as formatAmount } from '@/lib/utils'
import { useCompanyCurrency } from '@/hooks/use-company-currency'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import { PageHeader, FilterBar } from '@/components/ui/page-header'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface Asset {
  id: string; asset_no: string; name: string; purchase_date: string
  purchase_cost: number; status: string; accumulated_depreciation: number
}

export default function FixedAssetsPage() {
  const { currency } = useCompanyCurrency()
  const [assets, setAssets] = useState<Asset[]>([])
  const [filters, setFilters] = useState<FilterValues>({ status: '', from: '', to: '', minCost: '', maxCost: '' })
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: '', purchaseDate: new Date().toISOString().split('T')[0], purchaseCost: 0,
    usefulLifeMonths: 60, salvageValue: 0,
  })

  async function load() {
    setLoading(true)
    const res = await fetch('/api/fixed-assets')
    if (res.ok) setAssets(await res.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleSave() {
    setSaving(true)
    const res = await fetch('/api/fixed-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    if (!res.ok) alert(await readApiError(res))
    else { setShowModal(false); load() }
    setSaving(false)
  }

  const assetStatuses = useMemo(() => [...new Set(assets.map((a) => a.status))].sort(), [assets])
  const visible = useMemo(() => assets.filter((a) => {
    if (filters.status && a.status !== filters.status) return false
    if (filters.minCost !== '' && a.purchase_cost < Number(filters.minCost)) return false
    if (filters.maxCost !== '' && a.purchase_cost > Number(filters.maxCost)) return false
    return inDateRange(a.purchase_date, filters.from, filters.to)
  }), [assets, filters])
  const exportColumns: ExportColumn<Asset>[] = [
    { header: 'Asset No', value: (a) => a.asset_no }, { header: 'Name', value: (a) => a.name }, { header: 'Purchase Date', value: (a) => a.purchase_date, type: 'date' },
    { header: 'Purchase Cost', value: (a) => a.purchase_cost, type: 'currency' }, { header: 'Accumulated Depreciation', value: (a) => a.accumulated_depreciation, type: 'currency' },
    { header: 'Net Book Value', value: (a) => a.purchase_cost - a.accumulated_depreciation, type: 'currency' }, { header: 'Status', value: (a) => a.status },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Fixed Assets"
        subtitle={`${assets.length} assets`}
        breadcrumb={[{ label: 'Operations' }, { label: 'Fixed Assets' }]}
        action={<Button onClick={() => setShowModal(true)}><Plus size={15} /> New Asset</Button>}
      />

      <FilterBar>
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:bg-slate-50 bg-white">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        <ExportMenu filename="fixed-assets" sheetName="Fixed Assets" columns={exportColumns} rows={visible} />
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: assetStatuses.map((x) => ({ value: x, label: x })) }, { key: 'from', label: 'Purchased from', type: 'date' }, { key: 'to', label: 'Purchased to', type: 'date' }, { key: 'minCost', label: 'Min cost', type: 'number' }, { key: 'maxCost', label: 'Max cost', type: 'number' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full data-table">
          <thead>
            <tr className="border-b border-slate-100">
              {['Asset #', 'Name', 'Purchase Date', 'Cost', 'Accum. Dep.', 'Status'].map(h => (
                <th key={h} className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {visible.map(a => (
              <tr key={a.id}>
                <td className="px-4 py-3 font-mono text-xs text-indigo-600">{a.asset_no}</td>
                <td className="px-4 py-3 text-sm">{a.name}</td>
                <td className="px-4 py-3 text-xs">{formatDate(a.purchase_date)}</td>
                <td className="px-4 py-3 text-sm tabular">{formatAmount(Number(a.purchase_cost), currency)}</td>
                <td className="px-4 py-3 text-sm tabular">{formatAmount(Number(a.accumulated_depreciation), currency)}</td>
                <td className="px-4 py-3"><Badge status={a.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)} title="New Fixed Asset"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save</Button></>}
      >
        <div className="space-y-4">
          <Input label="Name" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <Input label="Purchase Date" type="date" value={form.purchaseDate} onChange={e => setForm({ ...form, purchaseDate: e.target.value })} />
          <Input label="Purchase Cost" type="number" min="0" value={form.purchaseCost} onChange={e => setForm({ ...form, purchaseCost: parseFloat(e.target.value) || 0 })} />
          <Input label="Useful Life (months)" type="number" value={form.usefulLifeMonths} onChange={e => setForm({ ...form, usefulLifeMonths: parseInt(e.target.value) || 60 })} />
        </div>
      </Modal>
    </div>
  )
}
