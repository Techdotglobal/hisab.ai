'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'

export interface AccountOption {
  id: string
  accountNo: string
  name: string
  fullName?: string | null
  parentNo?: string | null
}

interface AccountComboboxProps {
  accounts: AccountOption[]
  value: string
  onChange: (id: string) => void
  allLabel?: string
  className?: string
}

const MAX_VISIBLE = 100

/** Account depth in the chart of accounts, following parentNo links (guarded against cycles). */
function depthOf(account: AccountOption, byNo: Map<string, AccountOption>): number {
  let depth = 0
  let parent = account.parentNo
  while (parent && depth < 8) {
    const next = byNo.get(parent)
    if (!next) break
    depth += 1
    parent = next.parentNo
  }
  return depth
}

export function matchesAccount(account: AccountOption, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [account.accountNo, account.name, account.fullName].some((v) => v?.toLowerCase().includes(q))
}

/** Searchable account picker with an "All accounts" entry; filtering is client-side (no requests while typing). */
export function AccountCombobox({ accounts, value, onChange, allLabel = 'All Accounts', className = '' }: AccountComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const byNo = useMemo(() => new Map(accounts.map((a) => [a.accountNo, a])), [accounts])
  const selected = accounts.find((a) => a.id === value)
  const matches = useMemo(() => accounts.filter((a) => matchesAccount(a, query)), [accounts, query])
  const visible = matches.slice(0, MAX_VISIBLE)
  // Index 0 is the "All accounts" row (hidden while a search is active).
  const showAll = query.trim() === ''
  const rows = useMemo(() => [...(showAll ? [null] : []), ...visible], [showAll, visible])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  function openMenu() {
    setQuery('')
    setActive(0)
    setOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  function choose(id: string) {
    onChange(id)
    setOpen(false)
  }
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, rows.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const row = rows[active]; if (row !== undefined) choose(row ? row.id : '') }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <span className="truncate">{selected ? `${selected.accountNo} - ${selected.name}` : allLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[280px] rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <Search className="h-4 w-4 text-gray-400" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0) }}
              onKeyDown={onKeyDown}
              placeholder="Search by name or account code"
              aria-label="Search accounts"
              aria-controls={listId}
              aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
              className="w-full text-sm outline-none placeholder:text-gray-400"
            />
          </div>
          <ul id={listId} role="listbox" aria-label="Accounts" className="max-h-64 overflow-y-auto py-1">
            {rows.map((row, i) => {
              const isActive = i === active
              const isSelected = row ? row.id === value : value === ''
              return (
                <li
                  key={row ? row.id : 'all'}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); choose(row ? row.id : '') }}
                  style={row ? { paddingLeft: 12 + depthOf(row, byNo) * 12 } : undefined}
                  className={`cursor-pointer px-3 py-1.5 text-sm ${isActive ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'} ${isSelected ? 'font-medium' : ''}`}
                >
                  {row ? <><span className="font-mono text-xs text-gray-500">{row.accountNo}</span> {row.name}</> : allLabel}
                </li>
              )
            })}
            {matches.length === 0 && <li className="px-3 py-3 text-center text-sm text-gray-500" role="presentation">No accounts match &ldquo;{query.trim()}&rdquo;</li>}
            {matches.length > MAX_VISIBLE && (
              <li className="px-3 py-2 text-center text-xs text-gray-400" role="presentation">Showing {MAX_VISIBLE} of {matches.length} matches — keep typing to narrow down</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
