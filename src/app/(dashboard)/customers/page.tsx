'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Mail, Phone, Edit2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import {
  CustomerFilterCard,
  type CustomerFilterFacets,
} from '@/components/customers/customer-filter-card'
import {
  countActiveCustomerFilters,
  CUSTOMER_FILTERS_STORAGE_KEY,
  DEFAULT_CUSTOMER_FILTERS,
  loadStoredCustomerFilters,
  type CustomerFilterValues,
} from '@/lib/ui/customer-filters'
import { readApiError } from '@/lib/api-client'
import type { ExportColumn } from '@/lib/export/table-export'
import { ModuleImportExportToolbar } from '@/components/import-export/ModuleImportExportToolbar'
import { CUSTOMER_FIELDS } from '@/lib/import-export/registry/modules/customers.fields'

interface Customer {
  id: string; customerNo: string; name: string; email?: string; phone?: string
  city?: string; country?: string; taxId?: string; creditLimit: number
  paymentTerms: number; isActive: boolean; outstandingBalance?: number
}

const EMPTY_FACETS: CustomerFilterFacets = { countries: [], citiesByCountry: {} }

function buildQueryParams(filters: CustomerFilterValues): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.search.trim()) params.set('search', filters.search.trim())
  if (filters.country) params.set('country', filters.country)
  if (filters.city) params.set('city', filters.city)
  if (filters.vatFilter) params.set('vatFilter', filters.vatFilter)
  if (filters.balanceFilter) params.set('balanceFilter', filters.balanceFilter)
  params.set('sortBy', filters.sortBy)
  params.set('sortDir', filters.sortDir)
  return params
}

export default function CustomersPage() {
  const formatCurrency = useFormatCurrency()
  const { currency } = useCompanyCurrency()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [facets, setFacets] = useState<CustomerFilterFacets>(EMPTY_FACETS)
  const [filters, setFilters] = useState<CustomerFilterValues>(DEFAULT_CUSTOMER_FILTERS)
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [filtersReady, setFiltersReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: '', email: '', phone: '', address: '', city: '', country: 'Saudi Arabia',
    taxId: '', creditLimit: 0, paymentTerms: 30
  })

  useEffect(() => {
    const stored = loadStoredCustomerFilters()
    setFilters(stored)
    setDebouncedSearch(stored.search)
    setFiltersReady(true)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(filters.search)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [filters.search])

  const queryFilters = useMemo(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch],
  )

  const activeFilterCount = countActiveCustomerFilters(queryFilters)

  const load = useCallback(async () => {
    setLoading(true)
    const params = buildQueryParams(queryFilters)
    const res = await fetch(`/api/customers?${params}`)
    if (res.ok) setCustomers(await res.json())
    setLoading(false)
  }, [queryFilters])

  useEffect(() => {
    if (!filtersReady) return
    void load()
    try {
      localStorage.setItem(CUSTOMER_FILTERS_STORAGE_KEY, JSON.stringify(filters))
    } catch {
      // Ignore storage failures.
    }
  }, [filtersReady, load, filters])

  useEffect(() => {
    fetch('/api/customers/facets')
      .then((r) => (r.ok ? r.json() : EMPTY_FACETS))
      .then((data) => setFacets(data))
      .catch(() => setFacets(EMPTY_FACETS))
  }, [])

  function patchFilters(patch: Partial<CustomerFilterValues>) {
    setFilters((current) => ({ ...current, ...patch }))
  }

  function resetFilters() {
    setFilters(DEFAULT_CUSTOMER_FILTERS)
    setDebouncedSearch('')
    try {
      localStorage.removeItem(CUSTOMER_FILTERS_STORAGE_KEY)
    } catch {
      // Ignore storage failures.
    }
  }

  function removeFilterChip(key: keyof CustomerFilterValues) {
    switch (key) {
      case 'search':
        patchFilters({ search: '' })
        setDebouncedSearch('')
        break
      case 'country':
        patchFilters({ country: '', city: '' })
        break
      case 'city':
        patchFilters({ city: '' })
        break
      case 'vatFilter':
        patchFilters({ vatFilter: '' })
        break
      case 'balanceFilter':
        patchFilters({ balanceFilter: '' })
        break
      default:
        break
    }
  }

  function openCreate() {
    setEditing(null)
    setForm({ name: '', email: '', phone: '', address: '', city: '', country: 'Saudi Arabia', taxId: '', creditLimit: 0, paymentTerms: 30 })
    setShowModal(true)
  }

  function openEdit(c: Customer) {
    setEditing(c)
    setForm({ name: c.name, email: c.email || '', phone: c.phone || '', address: '', city: c.city || '', country: c.country || 'Saudi Arabia', taxId: c.taxId || '', creditLimit: c.creditLimit, paymentTerms: c.paymentTerms })
    setShowModal(true)
  }

  async function handleSave() {
    setSaving(true)
    const url = editing ? `/api/customers/${editing.id}` : '/api/customers'
    const res = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    if (!res.ok) {
      alert(await readApiError(res))
      setSaving(false)
      return
    }
    if (res.ok) {
      setShowModal(false)
      const facetsRes = await fetch('/api/customers/facets')
      if (facetsRes.ok) setFacets(await facetsRes.json())
      load()
    }
    setSaving(false)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this customer?')) return
    const res = await fetch(`/api/customers/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      alert(await readApiError(res))
      return
    }
    const facetsRes = await fetch('/api/customers/facets')
    if (facetsRes.ok) setFacets(await facetsRes.json())
    load()
  }

  const exportColumns: ExportColumn<Customer>[] = [
    { header: 'Customer No', value: (c) => c.customerNo }, { header: 'Name', value: (c) => c.name }, { header: 'Email', value: (c) => c.email }, { header: 'Phone', value: (c) => c.phone },
    { header: 'City', value: (c) => c.city }, { header: 'Country', value: (c) => c.country }, { header: 'Tax ID / VAT', value: (c) => c.taxId },
    { header: 'Credit Limit', value: (c) => c.creditLimit, type: 'currency' }, { header: 'Payment Terms (days)', value: (c) => c.paymentTerms, type: 'number' },
    { header: 'Outstanding Balance', value: (c) => c.outstandingBalance ?? 0, type: 'currency' }, { header: 'Status', value: (c) => c.isActive ? 'Active' : 'Inactive' },
  ]
  const subtitle = activeFilterCount > 0
    ? `${customers.length} matching customers`
    : `${customers.length} customers`

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-4">
      <PageHeader
        title="Customers"
        subtitle={subtitle}
        breadcrumb={[{ label: 'Income' }, { label: 'Customers' }]}
        action={(
          <div className="flex items-center gap-2">
            <ModuleImportExportToolbar
              moduleKey="customers"
              moduleLabel="Customers"
              fields={CUSTOMER_FIELDS}
              filters={Object.fromEntries(buildQueryParams(queryFilters))}
              onImportSuccess={load}
              tableExport={{ filename: 'customers', columns: exportColumns, rows: customers }}
            />
            <Button onClick={openCreate}><Plus size={15} /> New Customer</Button>
          </div>
        )}
      />

      <CustomerFilterCard
        filters={filters}
        facets={facets}
        onChange={patchFilters}
        onReset={resetFilters}
        onRemoveChip={removeFilterChip}
      />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['#', 'Name', 'Contact', 'City', 'Tax ID', 'Outstanding', 'Credit Limit', 'Terms', 'Status', ''].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left', ['Outstanding', 'Credit Limit'].includes(h) && 'text-right', h === 'Status' && 'text-center', h === '' && 'w-20')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 10 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : customers.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center">
                    {activeFilterCount > 0 ? (
                      <div className="space-y-3">
                        <p className="text-slate-500 text-sm">No customers match your filters.</p>
                        <Button variant="outline" size="sm" onClick={resetFilters}>
                          Clear filters
                        </Button>
                      </div>
                    ) : (
                      <p className="text-slate-400 text-sm">No customers yet. Add your first customer.</p>
                    )}
                  </td>
                </tr>
              ) : customers.map(c => (
                <tr key={c.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{c.customerNo}</td>
                  <td className="px-4 py-3 font-semibold text-slate-800">{c.name}</td>
                  <td className="px-4 py-3">
                    <div className="space-y-0.5">
                      {c.email && <div className="flex items-center gap-1.5 text-xs text-slate-500"><Mail size={10} />{c.email}</div>}
                      {c.phone && <div className="flex items-center gap-1.5 text-xs text-slate-500"><Phone size={10} />{c.phone}</div>}
                      {!c.email && !c.phone && <span className="text-slate-300 text-xs">—</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-600">{c.city || '—'}</td>
                  <td className="px-4 py-3 text-xs font-mono text-slate-500">{c.taxId || '—'}</td>
                  <td className="px-4 py-3 text-right font-semibold text-amber-700 tabular text-sm">{formatCurrency(c.outstandingBalance ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-700 tabular text-sm">{formatCurrency(c.creditLimit)}</td>
                  <td className="px-4 py-3 text-sm text-slate-600">Net {c.paymentTerms}d</td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn('badge', c.isActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-50 text-gray-500 border-gray-200')}>
                      {c.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEdit(c)} className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors" aria-label={`Edit ${c.name}`}><Edit2 size={13} /></button>
                      <button onClick={() => handleDelete(c.id)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" aria-label={`Delete ${c.name}`}><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)}
        title={editing ? 'Edit Customer' : 'New Customer'} size="md"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>Save</Button></>}
      >
        <div className="space-y-4">
          <Input label="Customer Name" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Company name" />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
            <Input label="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="City" value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} />
            <Input label="Country" value={form.country} onChange={e => setForm({ ...form, country: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Tax ID" value={form.taxId} onChange={e => setForm({ ...form, taxId: e.target.value })} />
            <Input label="Payment Terms (days)" type="number" value={form.paymentTerms} onChange={e => setForm({ ...form, paymentTerms: parseInt(e.target.value) || 30 })} />
          </div>
          <Input label={`Credit Limit (${currency})`} type="number" value={form.creditLimit} onChange={e => setForm({ ...form, creditLimit: parseFloat(e.target.value) || 0 })} />
        </div>
      </Modal>
    </div>
  )
}
