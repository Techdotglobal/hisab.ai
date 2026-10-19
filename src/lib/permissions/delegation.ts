/**
 * Delegation rules for user/permission management. Pure functions so every privilege-escalation
 * rule can be unit-tested and reused unchanged by the API layer and the UI preview.
 *
 * An actor's *authority* is expressed by two lists the OWNER sets when appointing a delegate:
 *   - manageableRoles: roles the delegate may create/assign/edit/deactivate (never OWNER)
 *   - delegable:       individual permissions the delegate may grant/revoke (never NON_REDELEGABLE)
 * The OWNER has full authority. A legacy ADMIN with no delegation record keeps the previous
 * behaviour (manage every non-owner role) but cannot grant individual permissions.
 */

import type { CompanyRole } from '@/lib/db/types'
import {
  ALL_PERMISSIONS,
  NON_REDELEGABLE,
  ROLE_BASELINES,
  hasPermission,
  type EffectiveAccess,
  type PermissionKey,
} from './catalog'

export const NON_OWNER_ROLES: CompanyRole[] = ['ADMIN', 'ACCOUNTANT', 'MANAGER', 'EMPLOYEE', 'AUDITOR']

export interface Delegation {
  manageableRoles: CompanyRole[]
  delegable: PermissionKey[]
}

export interface Principal {
  userId: string
  role: CompanyRole
  access: EffectiveAccess
  /** Active delegation record, if the owner appointed this user as a delegate. */
  delegation: Delegation | null
}

export interface Authority {
  manageableRoles: Set<CompanyRole>
  delegable: Set<PermissionKey>
  /** Every permission a managed user may legitimately hold (role baselines + delegable grants). */
  ceiling: Set<PermissionKey>
}

/** Sanitises an owner-supplied delegation so it can never contain OWNER or non-redelegable keys. */
export function normalizeDelegation(input: { manageableRoles?: unknown; delegable?: unknown }): Delegation {
  const roles = Array.isArray(input.manageableRoles) ? input.manageableRoles : []
  const perms = Array.isArray(input.delegable) ? input.delegable : []
  return {
    manageableRoles: [...new Set(roles.filter((r): r is CompanyRole => NON_OWNER_ROLES.includes(r as CompanyRole)))],
    delegable: [
      ...new Set(
        perms.filter(
          (k): k is PermissionKey =>
            (ALL_PERMISSIONS as string[]).includes(k as string) && !NON_REDELEGABLE.includes(k as PermissionKey),
        ),
      ),
    ],
  }
}

export function authorityOf(actor: Principal): Authority {
  let manageable: CompanyRole[]
  let delegable: PermissionKey[]
  if (actor.role === 'OWNER') {
    manageable = NON_OWNER_ROLES
    delegable = [...ALL_PERMISSIONS]
  } else if (actor.delegation) {
    const d = normalizeDelegation(actor.delegation)
    manageable = d.manageableRoles
    delegable = d.delegable
  } else if (actor.role === 'ADMIN') {
    manageable = NON_OWNER_ROLES
    delegable = []
  } else {
    manageable = []
    delegable = []
  }
  const ceiling = new Set<PermissionKey>(delegable)
  for (const role of manageable) for (const perm of ROLE_BASELINES[role]) ceiling.add(perm)
  return { manageableRoles: new Set(manageable), delegable: new Set(delegable), ceiling }
}

export type Denial =
  | 'missing_capability'
  | 'target_is_owner'
  | 'self_modification'
  | 'role_not_manageable'
  | 'target_exceeds_authority'
  | 'owner_role_forbidden'
  | 'permission_not_delegable'
  | 'permission_not_redelegable'

export class AccessDeniedError extends Error {
  constructor(public readonly reason: Denial, message?: string) {
    super(message ?? `Access change denied: ${reason}`)
    this.name = 'AccessDeniedError'
  }
}

export interface TargetInfo {
  userId: string
  role: CompanyRole
  access: EffectiveAccess
}

function requireCapability(actor: Principal, capability: PermissionKey) {
  if (!hasPermission(actor.access, capability)) throw new AccessDeniedError('missing_capability', `Requires ${capability}`)
}

/**
 * Can `actor` administer `target` at all? Owner is only constrained to leave the owner row alone.
 * For everyone else the target must be another user whose role is manageable and whose *effective*
 * access is entirely inside the actor's authority — otherwise editing (e.g. resetting the password
 * of) a more privileged account would be a privilege-escalation path.
 */
export function assertCanManageTarget(actor: Principal, target: TargetInfo): void {
  if (target.role === 'OWNER') throw new AccessDeniedError('target_is_owner', 'The owner account is protected.')
  if (actor.userId === target.userId && actor.role !== 'OWNER') {
    throw new AccessDeniedError('self_modification', 'You cannot change your own access.')
  }
  if (actor.role === 'OWNER') return
  const authority = authorityOf(actor)
  if (!authority.manageableRoles.has(target.role)) {
    throw new AccessDeniedError('role_not_manageable', 'This user is outside the roles you manage.')
  }
  for (const key of target.access.permissions.keys()) {
    if (!authority.ceiling.has(key)) {
      throw new AccessDeniedError('target_exceeds_authority', 'This user holds access beyond your delegated authority.')
    }
  }
}

export function assertCanCreateUser(actor: Principal, role: CompanyRole): void {
  requireCapability(actor, 'users.create')
  if ((role as string) === 'OWNER' || (role as string) === 'SUPER_ADMIN') {
    throw new AccessDeniedError('owner_role_forbidden', 'The Owner role can only be transferred.')
  }
  if (actor.role !== 'OWNER' && !authorityOf(actor).manageableRoles.has(role)) {
    throw new AccessDeniedError('role_not_manageable', 'You are not allowed to create users with this role.')
  }
}

export function assertCanEditUser(actor: Principal, target: TargetInfo): void {
  requireCapability(actor, 'users.edit')
  assertCanManageTarget(actor, target)
}

export function assertCanDeactivateUser(actor: Principal, target: TargetInfo): void {
  requireCapability(actor, 'users.deactivate')
  assertCanManageTarget(actor, target)
}

export function assertCanAssignRole(actor: Principal, target: TargetInfo, newRole: CompanyRole): void {
  requireCapability(actor, 'roles.assign')
  if ((newRole as string) === 'OWNER' || (newRole as string) === 'SUPER_ADMIN') {
    throw new AccessDeniedError('owner_role_forbidden', 'The Owner role can only be transferred.')
  }
  assertCanManageTarget(actor, target)
  if (actor.role !== 'OWNER' && !authorityOf(actor).manageableRoles.has(newRole)) {
    throw new AccessDeniedError('role_not_manageable', 'You are not allowed to assign this role.')
  }
}

/** Grant or revoke an individual permission. */
export function assertCanChangeGrant(actor: Principal, target: TargetInfo, permission: PermissionKey): void {
  requireCapability(actor, 'permissions.manage')
  assertCanManageTarget(actor, target)
  if (actor.role !== 'OWNER') {
    if (NON_REDELEGABLE.includes(permission)) {
      throw new AccessDeniedError('permission_not_redelegable', 'This permission can only be granted by the owner.')
    }
    if (!authorityOf(actor).delegable.has(permission)) {
      throw new AccessDeniedError('permission_not_delegable', 'This permission is outside your delegation limit.')
    }
  }
}

/** Only the owner appoints or revokes delegates; the delegate's own limits are never self-editable. */
export function assertCanManageDelegations(actor: Principal): void {
  if (actor.role !== 'OWNER') throw new AccessDeniedError('missing_capability', 'Only the owner can delegate access management.')
}

// ------------------------------------------------------------------------------------------------
// Review helpers
// ------------------------------------------------------------------------------------------------

export interface AccessWarning {
  code: string
  message: string
}

/** Flags conflicting or excessive privileges so the owner can review them before saving. */
export function analyzeAccess(access: EffectiveAccess, grants: PermissionKey[] = []): AccessWarning[] {
  const has = (k: PermissionKey) => hasPermission(access, k)
  const out: AccessWarning[] = []
  if (access.role !== 'OWNER') {
    if (has('journals.edit') && has('journals.post')) {
      out.push({ code: 'segregation_journals', message: 'Can both create and post journal entries (no segregation of duties).' })
    }
    if (has('payroll.manage') && has('employees.manage')) {
      out.push({ code: 'segregation_payroll', message: 'Can both change employee records and run payroll.' })
    }
    if (has('permissions.manage') && has('payroll.view')) {
      out.push({ code: 'admin_plus_confidential', message: 'Manages access and can also read payroll.' })
    }
    if (has('permissions.manage') && !has('users.view_permissions')) {
      out.push({ code: 'manage_without_view', message: 'Can manage permissions but cannot inspect effective access.' })
    }
  }
  for (const g of grants) {
    if (ROLE_BASELINES[access.role].includes(g)) {
      out.push({ code: 'redundant_grant', message: `${g} is already provided by the role.` })
    }
    const edit = g.replace(/\.(edit|manage|post|create|deactivate)$/, '.view') as PermissionKey
    if (edit !== g && (ALL_PERMISSIONS as string[]).includes(edit) && !has(edit)) {
      out.push({ code: 'edit_without_view', message: `${g} is granted without ${edit}.` })
    }
  }
  return out
}
