'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Minus, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select } from '@/components/ui/input'
import { readApiError } from '@/lib/api-client'
import { cn, formatDate } from '@/lib/utils'
import {
  NON_REDELEGABLE,
  PERMISSION_DEFS,
  type PermissionKey,
} from '@/lib/permissions/catalog'

export interface ViewerContext {
  id: string
  role: string
  permissions: string[]
  authority: { manageableRoles: string[]; delegable: string[] }
}

interface Grant {
  id: string
  permission: PermissionKey
  scope?: { costCenterIds?: string[] } | null
  grantedByName: string | null
  grantedAt: string | null
  reason: string | null
}
interface Effective { permission: PermissionKey; sources: Array<'role' | 'grant' | 'owner'>; scope: { costCenterIds?: string[] } | null }
interface Detail {
  userId: string
  name: string | null
  email: string
  role: string
  displayRole: string
  isActive: boolean
  roleBaseline: PermissionKey[]
  grants: Grant[]
  effective: Effective[]
  delegation: { manageableRoles: string[]; delegable: PermissionKey[]; grantedByName: string | null; note: string | null; createdAt: string } | null
  warnings: Array<{ code: string; message: string }>
  history: Array<{ id: string; action: string; actorName: string | null; createdAt: string; reason: string | null; before: unknown; after: unknown }>
}
interface Preview { gained: PermissionKey[]; lost: PermissionKey[]; resultingCount: number; warnings: Array<{ code: string; message: string }> }

const SOURCE_LABEL: Record<string, string> = { role: 'Role', grant: 'Individual grant', owner: 'Owner (protected)' }
const MANAGEABLE_ROLE_OPTIONS = ['ADMIN', 'ACCOUNTANT', 'MANAGER', 'EMPLOYEE', 'AUDITOR']
const ROLE_LABEL: Record<string, string> = { ADMIN: 'Admin', ACCOUNTANT: 'Accountant', MANAGER: 'Manager', EMPLOYEE: 'Employee', AUDITOR: 'Viewer' }

/** Delegation presets matching the four documented scenarios (A–D). */
const PRESETS: Array<{ id: string; label: string; help: string; capabilities: PermissionKey[]; manageableRoles: string[]; delegable: PermissionKey[] }> = [
  {
    id: 'A', label: 'View-only access manager', help: 'Can see users and inspect effective permissions. Cannot change anything.',
    capabilities: ['users.view', 'users.view_permissions', 'roles.view'], manageableRoles: [], delegable: [],
  },
  {
    id: 'B', label: 'User administrator', help: 'Can create, edit and deactivate Employee and Viewer users. Cannot assign roles or grant permissions.',
    capabilities: ['users.view', 'users.create', 'users.edit', 'users.deactivate'], manageableRoles: ['EMPLOYEE', 'AUDITOR'], delegable: [],
  },
  {
    id: 'C', label: 'Permission manager', help: 'Can assign Employee/Viewer roles and grant reports & ledger viewing — nothing beyond that.',
    capabilities: ['users.view', 'users.view_permissions', 'roles.assign', 'permissions.manage'], manageableRoles: ['EMPLOYEE', 'AUDITOR'],
    delegable: ['reports.view', 'ledger.view'],
  },
  {
    id: 'D', label: 'Combined delegated administrator', help: 'User administration plus permission management within the limits above. No financial, payroll or settings access.',
    capabilities: ['users.view', 'users.create', 'users.edit', 'users.deactivate', 'users.view_permissions', 'roles.assign', 'permissions.manage'],
    manageableRoles: ['EMPLOYEE', 'AUDITOR', 'MANAGER'], delegable: ['reports.view', 'ledger.view'],
  },
]

const jsonHeaders = { 'Content-Type': 'application/json' }

export function AccessPanel({ userId, viewer, onClose, onChanged }: { userId: string | null; viewer: ViewerContext | null; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [tab, setTab] = useState<'effective' | 'grants' | 'delegation' | 'history'>('effective')
  const [search, setSearch] = useState('')

  const isOwner = viewer?.role === 'SUPER_ADMIN'
  const canManage = Boolean(viewer?.permissions.includes('permissions.manage'))
  const delegable = useMemo(() => new Set(viewer?.authority.delegable ?? []), [viewer])

  const load = useCallback(() => setTick((t) => t + 1), [])
  // The parent remounts this panel per user (key), so state starts clean.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      const res = await fetch(`/api/users/${userId}/access`)
      if (cancelled) return
      if (!res.ok) setError(await readApiError(res))
      else { setError(null); setDetail(await res.json()) }
    })()
    return () => { cancelled = true }
  }, [userId, tick])
  const loading = !detail && !error

  const effectiveMap = useMemo(() => new Map((detail?.effective ?? []).map((e) => [e.permission, e])), [detail])
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out = new Map<string, typeof PERMISSION_DEFS[number][]>()
    for (const d of PERMISSION_DEFS) {
      if (q && !`${d.label} ${d.key} ${d.module}`.toLowerCase().includes(q)) continue
      out.set(d.module, [...(out.get(d.module) ?? []), d])
    }
    return out
  }, [search])

  const tabs: Array<[typeof tab, string]> = [['effective', 'Effective access'], ['grants', 'Individual grants'], ...(isOwner ? ([['delegation', 'Delegation']] as Array<[typeof tab, string]>) : []), ['history', 'History']]

  return (
    <Modal open={Boolean(userId)} onClose={onClose} size="xl"
      title={detail ? `Access — ${detail.name || detail.email}` : 'Access'}
      subtitle={detail ? `${detail.email} · ${detail.displayRole}${detail.isActive ? '' : ' · inactive'}` : undefined}
    >
      {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}
      {loading && !detail && <div className="skeleton h-40 rounded-xl" />}
      {detail && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1 border-b border-slate-100">
            {tabs.map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={cn('px-3 py-2 text-sm font-medium border-b-2 -mb-px', tab === id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700')}>
                {label}
              </button>
            ))}
          </div>

          {detail.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 space-y-1">
              <p className="font-semibold flex items-center gap-1"><AlertTriangle size={13} /> Review</p>
              {detail.warnings.map((w) => <p key={w.code + w.message}>• {w.message}</p>)}
            </div>
          )}

          {tab === 'effective' && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">
                {detail.effective.length} permissions are effective. <strong>Role</strong> permissions come from the {detail.displayRole} role; <strong>Individual grant</strong> permissions were added for this user only.
                Nothing is allowed unless it appears here as allowed.
              </p>
              <Input label="Search permissions" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-slate-100">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wider text-slate-400">
                    <tr><th className="px-3 py-2 text-left">Permission</th><th className="px-3 py-2 text-left">Source</th><th className="px-3 py-2 text-left">Scope</th><th className="px-3 py-2 text-center">Effective</th></tr>
                  </thead>
                  <tbody>
                    {[...grouped.entries()].map(([module, defs]) => (
                      <GroupRows key={module} module={module}>
                        {defs.map((d) => {
                          const eff = effectiveMap.get(d.key)
                          return (
                            <tr key={d.key} className="border-t border-slate-50">
                              <td className="px-3 py-2"><div className="font-medium text-slate-800">{d.label}</div><div className="text-[11px] text-slate-400">{d.key}</div></td>
                              <td className="px-3 py-2 text-slate-600">{eff ? eff.sources.map((s) => SOURCE_LABEL[s]).join(' + ') : 'No grant'}</td>
                              <td className="px-3 py-2 text-slate-600 text-xs">{eff?.scope?.costCenterIds?.length ? `${eff.scope.costCenterIds.length} cost center(s) only` : eff ? 'Company-wide' : '—'}</td>
                              <td className="px-3 py-2 text-center">{eff ? <Check size={15} className="inline text-emerald-600" /> : <Minus size={15} className="inline text-slate-300" />}</td>
                            </tr>
                          )
                        })}
                      </GroupRows>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'grants' && (
            <GrantsTab detail={detail} canManage={canManage} isOwner={isOwner} delegable={delegable} effectiveMap={effectiveMap}
              onDone={(msg) => { setNotice(msg); load(); onChanged() }} onError={setError} />
          )}

          {tab === 'delegation' && isOwner && (
            <DelegationTab detail={detail} effectiveMap={effectiveMap} onDone={(msg) => { setNotice(msg); load(); onChanged() }} onError={setError} />
          )}

          {tab === 'history' && (
            <div className="max-h-[50vh] overflow-y-auto space-y-2">
              {detail.history.length === 0 && <p className="text-sm text-slate-400">No access changes recorded.</p>}
              {detail.history.map((h) => (
                <div key={h.id} className="rounded-lg border border-slate-100 p-3 text-sm">
                  <div className="flex justify-between"><span className="font-semibold text-slate-800">{h.action.replace(/_/g, ' ').toLowerCase()}</span><span className="text-xs text-slate-400">{formatDate(h.createdAt)}</span></div>
                  <div className="text-xs text-slate-500">by {h.actorName || 'unknown'}{h.reason ? ` — “${h.reason}”` : ''}</div>
                  {(h.before || h.after) ? <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-500">{JSON.stringify({ before: h.before ?? undefined, after: h.after ?? undefined })}</pre> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function GroupRows({ module, children }: { module: string; children: React.ReactNode }) {
  return (
    <>
      <tr className="bg-slate-50/70"><td colSpan={4} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{module}</td></tr>
      {children}
    </>
  )
}

function GrantsTab({ detail, canManage, isOwner, delegable, effectiveMap, onDone, onError }: {
  detail: Detail; canManage: boolean; isOwner: boolean; delegable: Set<string>; effectiveMap: Map<PermissionKey, Effective>
  onDone: (msg: string) => void; onError: (msg: string | null) => void
}) {
  const [permission, setPermission] = useState('')
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState<PermissionKey | null>(null)

  const options = PERMISSION_DEFS.filter((d) => !effectiveMap.has(d.key) && (isOwner || (delegable.has(d.key) && !NON_REDELEGABLE.includes(d.key))))

  async function runPreview(p: string) {
    setPermission(p); setPreview(null); onError(null)
    if (!p) return
    const res = await fetch(`/api/users/${detail.userId}/access`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ grant: [p] }) })
    if (res.ok) setPreview(await res.json())
    else onError(await readApiError(res))
  }
  async function grant() {
    setBusy(true); onError(null)
    const res = await fetch(`/api/users/${detail.userId}/grants`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ permission, reason }) })
    setBusy(false)
    if (!res.ok) return onError(await readApiError(res))
    setPermission(''); setReason(''); setPreview(null)
    onDone('Permission granted.')
  }
  async function revoke(p: PermissionKey) {
    setBusy(true); onError(null)
    const res = await fetch(`/api/users/${detail.userId}/grants`, { method: 'DELETE', headers: jsonHeaders, body: JSON.stringify({ permission: p, reason: reason || undefined }) })
    setBusy(false); setConfirmRevoke(null)
    if (!res.ok) return onError(await readApiError(res))
    onDone('Grant revoked. Access ends immediately unless another source still provides it.')
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">Individual grants add one permission for this user without changing their role. Revoking removes only that grant.</p>
      <div className="space-y-2">
        {detail.grants.length === 0 && <p className="text-sm text-slate-400">No individual grants.</p>}
        {detail.grants.map((g) => (
          <div key={g.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 p-3 text-sm">
            <div>
              <div className="font-medium text-slate-800">{PERMISSION_DEFS.find((d) => d.key === g.permission)?.label ?? g.permission} <span className="text-[11px] text-slate-400">{g.permission}</span></div>
              <div className="text-xs text-slate-500">Granted by {g.grantedByName || 'unknown'}{g.grantedAt ? ` on ${formatDate(g.grantedAt)}` : ''}{g.reason ? ` — “${g.reason}”` : ''}</div>
            </div>
            {canManage && (confirmRevoke === g.permission ? (
              <div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => setConfirmRevoke(null)}>Keep</Button><Button size="sm" loading={busy} onClick={() => revoke(g.permission)}>Confirm revoke</Button></div>
            ) : (
              <button aria-label="Revoke grant" onClick={() => setConfirmRevoke(g.permission)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50"><Trash2 size={14} /></button>
            ))}
          </div>
        ))}
      </div>

      {canManage ? (
        <div className="rounded-xl border border-slate-200 p-4 space-y-3">
          <h4 className="text-sm font-semibold text-slate-800">Grant a permission</h4>
          <Select label="Permission" value={permission} onChange={(e) => runPreview(e.target.value)}>
            <option value="">— Select —</option>
            {options.map((d) => <option key={d.key} value={d.key}>{d.module}: {d.label}</option>)}
          </Select>
          {!isOwner && <p className="text-[11px] text-slate-400">You can only grant permissions inside the delegation limit set by the owner.</p>}
          <Input label="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {preview && (
            <div className="rounded-lg bg-slate-50 p-3 text-xs space-y-1">
              <p className="font-semibold text-slate-700">Preview — after saving this user has {preview.resultingCount} permissions</p>
              {preview.gained.map((k) => <p key={k} className="text-emerald-700">+ {k}</p>)}
              {preview.warnings.map((w) => <p key={w.message} className="text-amber-700">⚠ {w.message}</p>)}
            </div>
          )}
          <Button onClick={grant} loading={busy} disabled={!permission}><ShieldCheck size={14} /> Grant permission</Button>
        </div>
      ) : (
        <p className="text-xs text-slate-400">You do not have permission to change individual grants.</p>
      )}
    </div>
  )
}

function DelegationTab({ detail, effectiveMap, onDone, onError }: {
  detail: Detail; effectiveMap: Map<PermissionKey, Effective>; onDone: (msg: string) => void; onError: (msg: string | null) => void
}) {
  const [roles, setRoles] = useState<string[]>(detail.delegation?.manageableRoles ?? [])
  const [perms, setPerms] = useState<string[]>(detail.delegation?.delegable ?? [])
  const [note, setNote] = useState(detail.delegation?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<null | 'save' | 'revoke'>(null)
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const delegablePerms = PERMISSION_DEFS.filter((d) => !NON_REDELEGABLE.includes(d.key) && !d.key.startsWith('users.') && d.module !== 'Users & access')

  async function applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id)!
    setRoles(p.manageableRoles); setPerms(p.delegable)
    setNote(p.label)
    onError(null)
    // Capabilities are separate individual grants so the backend gate (not the delegation list) allows the action.
    for (const cap of p.capabilities) {
      if (effectiveMap.has(cap)) continue
      const res = await fetch(`/api/users/${detail.userId}/grants`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ permission: cap, reason: `Delegation preset: ${p.label}` }) })
      if (!res.ok) return onError(`Could not grant ${cap}: ${await readApiError(res)}`)
    }
    await save(p.manageableRoles, p.delegable, p.label)
  }
  async function save(r = roles, d = perms, n = note) {
    setBusy(true); onError(null)
    const res = await fetch(`/api/users/${detail.userId}/delegation`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ manageableRoles: r, delegable: d, note: n }) })
    setBusy(false); setConfirm(null)
    if (!res.ok) return onError(await readApiError(res))
    onDone('Delegation saved.')
  }
  async function revoke() {
    setBusy(true); onError(null)
    const res = await fetch(`/api/users/${detail.userId}/delegation`, { method: 'DELETE' })
    setBusy(false); setConfirm(null)
    if (!res.ok) return onError(await readApiError(res))
    onDone('Delegation revoked. The delegate can no longer manage users or permissions through it.')
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        Delegation sets <strong>how far</strong> this person can administer access. It does not grant financial access, and a delegate can never grant
        permissions.manage, roles.manage or the Owner role, nor change their own access. Individual grants (users.*, permissions.manage…) decide <strong>which actions</strong> they can attempt.
      </p>
      {detail.delegation ? (
        <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3 text-xs text-slate-700">
          Active delegate since {formatDate(detail.delegation.createdAt)}{detail.delegation.grantedByName ? ` (by ${detail.delegation.grantedByName})` : ''}.
        </div>
      ) : <p className="text-xs text-slate-400">This user is not a delegate.</p>}

      <div className="grid gap-2 sm:grid-cols-2">
        {PRESETS.map((p) => (
          <button key={p.id} disabled={busy} onClick={() => applyPreset(p.id)} className="rounded-lg border border-slate-200 p-3 text-left hover:border-indigo-300 hover:bg-indigo-50/40">
            <div className="text-sm font-semibold text-slate-800">{p.id}. {p.label}</div>
            <div className="text-[11px] text-slate-500">{p.help}</div>
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 p-4 space-y-3">
        <h4 className="text-sm font-semibold text-slate-800">Delegation limits</h4>
        <div>
          <p className="text-xs font-medium text-slate-600 mb-1">Roles this person may create, assign, edit and deactivate</p>
          <div className="flex flex-wrap gap-2">
            {MANAGEABLE_ROLE_OPTIONS.map((r) => (
              <label key={r} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={roles.includes(r)} onChange={() => toggle(roles, setRoles, r)} /> {ROLE_LABEL[r]}</label>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-slate-600 mb-1">Individual permissions this person may grant to others</p>
          <div className="max-h-40 overflow-y-auto grid gap-1 sm:grid-cols-2">
            {delegablePerms.map((d) => (
              <label key={d.key} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={perms.includes(d.key)} onChange={() => toggle(perms, setPerms, d.key)} /> {d.label}</label>
            ))}
          </div>
        </div>
        <Input label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex gap-2">
          {confirm === 'save' ? (
            <><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button loading={busy} onClick={() => save()}>Confirm delegation</Button></>
          ) : <Button onClick={() => setConfirm('save')}>Save delegation</Button>}
          {detail.delegation && (confirm === 'revoke'
            ? <><Button variant="outline" onClick={() => setConfirm(null)}>Keep</Button><Button loading={busy} onClick={revoke}>Confirm revoke</Button></>
            : <Button variant="outline" onClick={() => setConfirm('revoke')}>Revoke delegation</Button>)}
        </div>
      </div>
    </div>
  )
}
