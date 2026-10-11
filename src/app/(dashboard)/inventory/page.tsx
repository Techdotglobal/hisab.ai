'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Edit2, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import { PageHeader, SearchBar, FilterBar } from '@/components/ui/page-header'
import { ModuleImportExportToolbar } from '@/components/import-export/ModuleImportExportToolbar'
import { INVENTORY_FIELDS } from '@/lib/import-export/registry/modules/inventory.fields'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

interface InventoryItem {
  id: string; itemCode: string; name: string; description?: string; category?: string
  unit: string; costPrice: number; salePrice: number; quantity: number; minQuantity: number; isActive: boolean
}

export default function InventoryPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [items, setItems] = useState<InventoryItem[]>([])
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterValues>({ category: '', stock: '', status: '', unit: '', minPrice: '', maxPrice: '' })
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<InventoryItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: '', description: '', category: '', unit: 'PCS',
    costPrice: 0, salePrice: 0, quantity: 0, minQuantity: 0
  })

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    const res = await fetch(`/api/inventory?${params}`)
    if (res.ok) setItems(await res.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [search])

  function openCreate() {
    setEditing(null)
    setForm({ name: '', description: '', category: '', unit: 'PCS', costPrice: 0, salePrice: 0, quantity: 0, minQuantity: 0 })
    setShowModal(true)
  }

  function openEdit(item: InventoryItem) {
    setEditing(item)
    setForm({ name: item.name, description: item.description || '', category: item.category || '', unit: item.unit, costPrice: item.costPrice, salePrice: item.salePrice, quantity: item.quantity, minQuantity: item.minQuantity })
    setShowModal(true)
  }

  async function handleSave() {
    setSaving(true)
    const url = editing ? `/api/inventory/${editing.id}` : '/api/inventory'
    const res = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    if (!res.ok) {
      alert(await readApiError(res))
      setSaving(false)
      return
    }
    if (res.ok) { setShowModal(false); load() }
    setSaving(false)
  }

  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean) as string[])].sort(), [items])
  const units = useMemo(() => [...new Set(items.map((i) => i.unit).filter(Boolean))].sort(), [items])
  const visible = useMemo(() => items.filter((i) => {
    if (filters.category && i.category !== filters.category) return false
    if (filters.unit && i.unit !== filters.unit) return false
    if (filters.status && (filters.status === 'active') !== i.isActive) return false
    if (filters.stock === 'low' && !(i.quantity <= i.minQuantity)) return false
    if (filters.stock === 'out' && i.quantity > 0) return false
    if (filters.stock === 'in' && i.quantity <= 0) return false
    if (filters.minPrice !== '' && i.salePrice < Number(filters.minPrice)) return false
    if (filters.maxPrice !== '' && i.salePrice > Number(filters.maxPrice)) return false
    return true
  }), [items, filters])
  const exportColumns: ExportColumn<InventoryItem>[] = [
    { header: 'Item Code', value: (i) => i.itemCode }, { header: 'Name', value: (i) => i.name }, { header: 'Description', value: (i) => i.description }, { header: 'Category', value: (i) => i.category },
    { header: 'Unit', value: (i) => i.unit }, { header: 'Cost Price', value: (i) => i.costPrice, type: 'currency' }, { header: 'Sale Price', value: (i) => i.salePrice, type: 'currency' },
    { header: 'Quantity', value: (i) => i.quantity, type: 'number' }, { header: 'Min Quantity', value: (i) => i.minQuantity, type: 'number' },
    { header: 'Stock Value', value: (i) => i.quantity * i.costPrice, type: 'currency' }, { header: 'Status', value: (i) => i.isActive ? 'Active' : 'Inactive' },
  ]
  const lowStock = items.filter(i => i.quantity <= i.minQuantity && i.isActive).length
  const totalValue = items.reduce((s, i) => s + i.quantity * i.costPrice, 0)

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Inventory"
        subtitle={`${items.length} items · ${formatCurrency(totalValue)} total value`}
        breadcrumb={[{ label: 'Operations' }, { label: 'Inventory' }]}
        action={(
          <div className="flex items-center gap-2">
            <ModuleImportExportToolbar
              moduleKey="inventory"
              moduleLabel="Inventory"
              fields={INVENTORY_FIELDS}
              filters={search ? { search } : {}}
              onImportSuccess={load}
              tableExport={{ filename: 'inventory', columns: exportColumns, rows: visible }}
            />
            <Button onClick={openCreate}><Plus size={15} /> New Item</Button>
          </div>
        )}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Items', value: items.length, color: 'text-slate-700' },
          { label: 'Low Stock', value: lowStock, color: lowStock > 0 ? 'text-amber-600' : 'text-emerald-600' },
          { label: 'Total Value', value: formatCurrency(totalValue), color: 'text-indigo-600' },
          { label: 'Active Items', value: items.filter(i => i.isActive).length, color: 'text-emerald-600' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 px-4 py-3">
            <p className="text-xs text-slate-400 font-medium">{s.label}</p>
            <p className={cn('text-lg font-bold mt-0.5', s.color)}>{s.value}</p>
          </div>
        ))}
      </div>

      <FilterBar>
        <SearchBar value={search} onChange={setSearch} placeholder="Search items..." className="flex-1 max-w-sm" />
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </FilterBar>
      <FilterPanel applied={filters} onApply={setFilters} fields={[{ key: 'category', label: 'Category', type: 'select', allLabel: 'All categories', options: categories.map((c) => ({ value: c, label: c })) }, { key: 'stock', label: 'Stock level', type: 'select', allLabel: 'Any', options: [{ value: 'in', label: 'In stock' }, { value: 'low', label: 'Low stock' }, { value: 'out', label: 'Out of stock' }] }, { key: 'status', label: 'Status', type: 'select', allLabel: 'Active & inactive', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] }, { key: 'unit', label: 'Unit', type: 'select', allLabel: 'All units', options: units.map((u) => ({ value: u, label: u })) }, { key: 'minPrice', label: 'Min sale price', type: 'number' }, { key: 'maxPrice', label: 'Max sale price', type: 'number' }]} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['Code', 'Name', 'Category', 'Unit', 'Cost', 'Sale Price', 'Qty', 'Min Qty', 'Value', ''].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left',
                    ['Cost', 'Sale Price', 'Value'].includes(h) && 'text-right', h === '' && 'w-16', h === 'Qty' && 'text-center')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 10 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : visible.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-16 text-center text-slate-400 text-sm">No inventory items yet.</td></tr>
              ) : visible.map(item => {
                const isLow = item.quantity <= item.minQuantity
                return (
                  <tr key={item.id} className={cn('hover:bg-slate-50/60 transition-colors', isLow && 'bg-amber-50/30')}>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{item.itemCode}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {isLow && <AlertTriangle size={13} className="text-amber-500 flex-shrink-0" />}
                        <span className="font-semibold text-slate-800 text-sm">{item.name}</span>
                      </div>
                      {item.description && <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{item.category || '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{item.unit}</td>
                    <td className="px-4 py-3 text-right text-sm tabular text-slate-700">{formatCurrency(item.costPrice)}</td>
                    <td className="px-4 py-3 text-right text-sm tabular text-slate-700">{formatCurrency(item.salePrice)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={cn('text-sm font-bold tabular', isLow ? 'text-amber-600' : 'text-slate-800')}>{item.quantity}</span>
                    </td>
                    <td className="px-4 py-3 text-center text-sm text-slate-500 tabular">{item.minQuantity}</td>
                    <td className="px-4 py-3 text-right font-semibold text-indigo-600 tabular text-sm">{formatCurrency(item.quantity * item.costPrice)}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => openEdit(item)} className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"><Edit2 size={13} /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)}
        title={editing ? 'Edit Item' : 'New Item'} size="md"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save Item</Button></>}
      >
        <div className="space-y-4">
          <Input label="Item Name" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Category" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} />
            <Input label="Unit" value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} placeholder="PCS, KG, L, M..." />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label={`Cost Price (${currency})`} type="number" value={form.costPrice} onChange={e => setForm({ ...form, costPrice: parseFloat(e.target.value) || 0 })} />
            <Input label={`Sale Price (${currency})`} type="number" value={form.salePrice} onChange={e => setForm({ ...form, salePrice: parseFloat(e.target.value) || 0 })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Current Quantity" type="number" value={form.quantity} onChange={e => setForm({ ...form, quantity: parseFloat(e.target.value) || 0 })} />
            <Input label="Min Quantity (Reorder)" type="number" value={form.minQuantity} onChange={e => setForm({ ...form, minQuantity: parseFloat(e.target.value) || 0 })} />
          </div>
          <Input label="Description" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
        </div>
      </Modal>
    </div>
  )
}
