'use client'

import { useState } from 'react'
import { Filter, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface FilterOption { value: string; label: string }

export type FilterField =
  | { key: string; label: string; type: 'select'; options: FilterOption[]; allLabel?: string }
  | { key: string; label: string; type: 'date' }
  | { key: string; label: string; type: 'text'; placeholder?: string }
  | { key: string; label: string; type: 'number'; placeholder?: string }

export type FilterValues = Record<string, string>

interface FilterPanelProps {
  fields: FilterField[]
  /** Currently applied filters. */
  applied: FilterValues
  /** Values restored by "Clear Filters" (defaults to all empty). */
  defaults?: FilterValues
  onApply: (values: FilterValues) => void
}

const labelCls = 'text-xs font-semibold uppercase tracking-wide text-slate-600'

export function countActiveFilters(applied: FilterValues, defaults: FilterValues = {}): number {
  return Object.entries(applied).filter(([k, v]) => v !== '' && v != null && v !== (defaults[k] ?? '')).length
}

/** Pairs `xxxFrom`/`xxxTo` (or `from`/`to`) date keys and reports an inverted range. */
function isRangeInverted(fields: FilterField[], draft: FilterValues): boolean {
  return fields.some((f) => {
    if (f.type !== 'date' || !/from$/i.test(f.key)) return false
    const toKey = f.key.replace(/from$/i, (m) => (m === 'From' ? 'To' : 'to'))
    return Boolean(draft[f.key] && draft[toKey] && draft[f.key] > draft[toKey])
  })
}

/** Draft-then-apply filter panel with Apply Filters / Clear Filters actions. */
export function FilterPanel({ fields, applied, defaults = {}, onApply }: FilterPanelProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<FilterValues>(applied)
  const active = countActiveFilters(applied, defaults)
  const rangeInvalid = isRangeInverted(fields, draft)

  function toggle() {
    if (!open) setDraft(applied)
    setOpen((v) => !v)
  }
  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }))

  function apply() {
    if (rangeInvalid) return
    onApply(draft)
  }
  function clear() {
    const reset = Object.fromEntries(fields.map((f) => [f.key, defaults[f.key] ?? '']))
    setDraft(reset)
    onApply(reset)
  }

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={active ? 'secondary' : 'outline'} onClick={toggle} aria-expanded={open}>
          <Filter size={14} /> Filters
          {active > 0 && <span className="rounded-full bg-indigo-600 px-1.5 text-[10px] font-bold text-white">{active}</span>}
        </Button>
        {active > 0 && (
          <button onClick={clear} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700">
            <X size={12} /> Clear filters
          </button>
        )}
      </div>
      {open && (
        <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {fields.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <label htmlFor={`flt-${f.key}`} className={labelCls}>{f.label}</label>
                {f.type === 'select' ? (
                  <select id={`flt-${f.key}`} className="input-base" value={draft[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="">{f.allLabel ?? 'All'}</option>
                    {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : (
                  <input
                    id={`flt-${f.key}`}
                    className="input-base"
                    type={f.type}
                    placeholder={'placeholder' in f ? f.placeholder : undefined}
                    value={draft[f.key] ?? ''}
                    onChange={(e) => set(f.key, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') apply() }}
                  />
                )}
              </div>
            ))}
          </div>
          {rangeInvalid && <p className="mt-3 text-xs text-rose-600">The From date must be on or before the To date.</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={clear}>Clear Filters</Button>
            <Button onClick={apply} disabled={rangeInvalid}>Apply Filters</Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Inclusive YYYY-MM-DD range check against an ISO date/datetime string. */
export function inDateRange(value: string | Date | null | undefined, from?: string, to?: string): boolean {
  if (!from && !to) return true
  if (!value) return false
  const day = (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10)
  return (!from || day >= from) && (!to || day <= to)
}
