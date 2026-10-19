import type { CompanyRole } from '@/lib/db/types'
import {
  listEffective,
  resolveEffectiveAccess,
  type PermissionGrant,
  type PermissionKey,
} from './catalog'
import { analyzeAccess, type AccessWarning } from './delegation'

export interface AccessChange {
  role?: CompanyRole
  addGrants?: PermissionGrant[]
  revokeGrants?: PermissionKey[]
}

export interface AccessPreview {
  gained: PermissionKey[]
  lost: PermissionKey[]
  unchanged: number
  resultingCount: number
  warnings: AccessWarning[]
}

/** Computes what a user's effective access would become — without writing anything. */
export function previewAccessChange(
  current: { role: CompanyRole; grants: PermissionGrant[] },
  change: AccessChange,
): AccessPreview {
  const before = resolveEffectiveAccess(current.role, current.grants)
  const revoked = new Set(change.revokeGrants ?? [])
  const nextGrants = [
    ...current.grants.filter((g) => !revoked.has(g.permission)),
    ...(change.addGrants ?? []).filter((g) => !current.grants.some((c) => c.permission === g.permission && !revoked.has(c.permission))),
  ]
  const after = resolveEffectiveAccess(change.role ?? current.role, nextGrants)

  const beforeKeys = new Set(listEffective(before).map((e) => e.permission))
  const afterKeys = new Set(listEffective(after).map((e) => e.permission))
  const gained = [...afterKeys].filter((k) => !beforeKeys.has(k))
  const lost = [...beforeKeys].filter((k) => !afterKeys.has(k))
  return {
    gained,
    lost,
    unchanged: [...afterKeys].filter((k) => beforeKeys.has(k)).length,
    resultingCount: afterKeys.size,
    warnings: analyzeAccess(after, nextGrants.map((g) => g.permission)),
  }
}
