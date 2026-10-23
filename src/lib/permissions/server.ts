import 'server-only'
import { requireAuth } from '@/lib/auth'
import { ForbiddenError } from '@/lib/authz'
import type { CompanyRole } from '@/lib/db/types'
import { memoPerRequest } from '@/lib/request-memo'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import {
  hasPermission,
  isCompanyRole,
  isPermissionKey,
  resolveEffectiveAccess,
  type EffectiveAccess,
  type PermissionGrant,
  type PermissionKey,
} from './catalog'
import { normalizeDelegation, type Delegation, type Principal, type TargetInfo } from './delegation'

export interface GrantRecord extends PermissionGrant {
  id: string
  userId: string
  revokedAt: string | null
}

export interface DelegationRecord extends Delegation {
  id: string
  userId: string
  grantedBy: string | null
  note: string | null
  createdAt: string
}

export interface AccessSnapshot {
  userId: string
  companyId: string
  role: CompanyRole
  isActive: boolean
  access: EffectiveAccess
  grants: GrantRecord[]
  delegation: DelegationRecord | null
}

/**
 * Loads a user's membership, active grants and active delegation straight from the database on every
 * call (no caching), so revoking a grant or delegation takes effect on the very next request.
 */
export async function loadAccessSnapshot(userId: string, companyId: string): Promise<AccessSnapshot | null> {
  const admin = createAdminClient()
  const [membership, grants, delegation] = await Promise.all([
    admin.from('company_users').select('role, is_active').eq('company_id', companyId).eq('user_id', userId).maybeSingle(),
    admin
      .from('user_permission_grants')
      .select('id, user_id, permission, scope, granted_by, reason, created_at')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .is('revoked_at', null),
    admin
      .from('access_delegations')
      .select('id, user_id, manageable_roles, delegable_permissions, granted_by, note, created_at')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .maybeSingle(),
  ])
  if (membership.error) throw membership.error
  if (grants.error) throw grants.error
  if (delegation.error) throw delegation.error
  if (!membership.data) return null

  const role = membership.data.role as string
  if (!isCompanyRole(role)) return null

  const grantRecords: GrantRecord[] = (grants.data ?? [])
    .filter((g) => isPermissionKey(g.permission))
    .map((g) => ({
      id: String(g.id),
      userId: String(g.user_id),
      permission: g.permission as PermissionKey,
      scope: (g.scope as PermissionGrant['scope']) ?? null,
      grantedBy: (g.granted_by as string | null) ?? null,
      grantedAt: String(g.created_at),
      reason: (g.reason as string | null) ?? null,
      revokedAt: null,
    }))

  const delegationRecord: DelegationRecord | null = delegation.data
    ? {
        id: String(delegation.data.id),
        userId: String(delegation.data.user_id),
        grantedBy: (delegation.data.granted_by as string | null) ?? null,
        note: (delegation.data.note as string | null) ?? null,
        createdAt: String(delegation.data.created_at),
        ...normalizeDelegation({
          manageableRoles: delegation.data.manageable_roles,
          delegable: delegation.data.delegable_permissions,
        }),
      }
    : null

  return {
    userId,
    companyId,
    role,
    isActive: Boolean(membership.data.is_active),
    access: resolveEffectiveAccess(role, grantRecords),
    grants: grantRecords,
    delegation: delegationRecord,
  }
}

/**
 * The caller's own snapshot, shared across the permission checks of one request (the route guard plus any
 * `requirePermission` in the handler). Target users are always read fresh through `loadAccessSnapshot`,
 * so a handler that edits someone's access never sees its own stale read.
 */
function loadCallerSnapshot(userId: string, companyId: string): Promise<AccessSnapshot | null> {
  return memoPerRequest(`access.caller:${companyId}:${userId}`, () => loadAccessSnapshot(userId, companyId))
}

export function toPrincipal(snapshot: AccessSnapshot): Principal {
  return { userId: snapshot.userId, role: snapshot.role, access: snapshot.access, delegation: snapshot.delegation }
}

export function toTarget(snapshot: AccessSnapshot): TargetInfo {
  return { userId: snapshot.userId, role: snapshot.role, access: snapshot.access }
}

export interface AuthorizedContext {
  id: string
  name: string | null
  email: string
  companyId: string
  role: CompanyRole
  snapshot: AccessSnapshot
  principal: Principal
}

/**
 * Central backend authorization check: validated session → company context → effective
 * permissions → required permission. Identity and company always come from the server-side
 * session; nothing in the request body or query string is trusted.
 *
 * Throws Error('Unauthorized') (401) or ForbiddenError (403).
 */
export async function requirePermission(...required: PermissionKey[]): Promise<AuthorizedContext> {
  const user = await requireAuth()
  const companyId = await resolveCompanyId()
  const snapshot = await loadCallerSnapshot(user.id, companyId)
  if (!snapshot || !snapshot.isActive) throw new ForbiddenError()
  for (const permission of required) {
    if (!hasPermission(snapshot.access, permission)) throw new ForbiddenError()
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    companyId,
    role: snapshot.role,
    snapshot,
    principal: toPrincipal(snapshot),
  }
}

/** Passes if the user holds ANY of the listed permissions. */
export async function requireAnyPermission(...anyOf: PermissionKey[]): Promise<AuthorizedContext> {
  const user = await requireAuth()
  const companyId = await resolveCompanyId()
  const snapshot = await loadCallerSnapshot(user.id, companyId)
  if (!snapshot || !snapshot.isActive || !anyOf.some((p) => hasPermission(snapshot.access, p))) throw new ForbiddenError()
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    companyId,
    role: snapshot.role,
    snapshot,
    principal: toPrincipal(snapshot),
  }
}
