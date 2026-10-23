import 'server-only'
import { extractClientIp } from '@/lib/accounting/posting-audit'
import { logAudit } from '@/lib/audit/log'
import type { CompanyRole } from '@/lib/db/types'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAppUser, fromDisplayRole, loadProfilesById, publicRole, updateAppUser, deleteAppUser } from '@/lib/supabase/auth-users'
import {
  ROLE_BASELINES,
  hasPermission,
  isPermissionKey,
  listEffective,
  resolveEffectiveAccess,
  type EffectivePermission,
  type PermissionKey,
  type PermissionScope,
} from './catalog'
import {
  AccessDeniedError,
  analyzeAccess,
  assertCanAssignRole,
  assertCanChangeGrant,
  assertCanCreateUser,
  assertCanDeactivateUser,
  assertCanEditUser,
  assertCanManageDelegations,
  normalizeDelegation,
  type AccessWarning,
  type Delegation,
} from './delegation'
import { previewAccessChange, type AccessChange, type AccessPreview } from './preview'
import {
  loadAccessSnapshot,
  toTarget,
  type AccessSnapshot,
  type AuthorizedContext,
  type DelegationRecord,
  type GrantRecord,
} from './server'

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** Loads a company member; users of other companies simply do not exist from the caller's view. */
async function loadTargetOrThrow(ctx: AuthorizedContext, userId: string): Promise<AccessSnapshot> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new NotFoundError()
  const snap = await loadAccessSnapshot(userId, ctx.companyId)
  if (!snap) throw new NotFoundError()
  return snap
}

function parseRole(input: unknown): CompanyRole {
  try {
    return fromDisplayRole(String(input))
  } catch (e) {
    if (e instanceof Error && e.name === 'OwnershipGuardError') {
      throw new AccessDeniedError('owner_role_forbidden', e.message)
    }
    throw new ValidationError('Unknown role')
  }
}

async function auditDenied(ctx: AuthorizedContext, action: string, entityId: string | null, error: AccessDeniedError, req?: Request) {
  try {
    await logAudit({
      companyId: ctx.companyId,
      userId: ctx.id,
      action: 'ACCESS_CHANGE_DENIED',
      entityType: 'user_access',
      entityId,
      details: { attempted: action, reason: error.reason },
      ipAddress: req ? extractClientIp(req) : null,
    })
  } catch (auditError) {
    console.error('Failed to audit denied access change', auditError)
  }
}

/** Runs an authorization assertion; a denial is itself audit-logged before being re-thrown. */
async function guardAccessChange(ctx: AuthorizedContext, action: string, entityId: string | null, req: Request | undefined, check: () => void) {
  try {
    check()
  } catch (error) {
    if (error instanceof AccessDeniedError) await auditDenied(ctx, action, entityId, error, req)
    throw error
  }
}

// ------------------------------------------------------------------------------------------------
// Directory
// ------------------------------------------------------------------------------------------------

export interface UserAccessSummary {
  id: string
  name: string | null
  email: string
  isActive: boolean
  role: string
  storedRole: CompanyRole
  department: string | null
  effectivePermissionCount: number
  individualGrantCount: number
  canManageUsers: boolean
  canManagePermissions: boolean
  canApproveOrPost: boolean
  isDelegate: boolean
  lastActivity: string | null
  createdAt: string
}

export async function listUsersWithAccess(companyId: string): Promise<UserAccessSummary[]> {
  const admin = createAdminClient()
  const [members, grants, delegations] = await Promise.all([
    admin
      .from('company_users')
      .select('user_id, role, is_active, created_at')
      .eq('company_id', companyId),
    admin.from('user_permission_grants').select('user_id, permission, scope').eq('company_id', companyId).is('revoked_at', null),
    admin.from('access_delegations').select('user_id').eq('company_id', companyId).is('revoked_at', null),
  ])
  if (members.error) throw members.error
  if (grants.error) throw grants.error
  if (delegations.error) throw delegations.error

  const grantsByUser = new Map<string, Array<{ permission: PermissionKey; scope: PermissionScope | null }>>()
  for (const g of grants.data ?? []) {
    if (!isPermissionKey(g.permission)) continue
    const list = grantsByUser.get(String(g.user_id)) ?? []
    list.push({ permission: g.permission, scope: (g.scope as PermissionScope | null) ?? null })
    grantsByUser.set(String(g.user_id), list)
  }
  const delegates = new Set((delegations.data ?? []).map((d) => String(d.user_id)))
  // company_users and profiles both reference auth.users, with no foreign key between them, so PostgREST
  // cannot embed one in the other — load the profiles with a second query.
  const profiles = await loadProfilesById(admin, (members.data ?? []).map((m) => String(m.user_id)))

  const rows = await Promise.all(
    (members.data ?? []).map(async (m) => {
      const id = String(m.user_id)
      const { data: auth } = await admin.auth.admin.getUserById(id)
      const profile = profiles.get(id) ?? null
      const storedRole = m.role as CompanyRole
      const own = grantsByUser.get(id) ?? []
      const access = resolveEffectiveAccess(storedRole, own)
      const email = auth?.user?.email ?? ''
      return {
        id,
        name: profile?.full_name ?? email.split('@')[0] ?? null,
        email,
        isActive: Boolean((m.is_active ?? true) && (profile?.is_active ?? true)),
        role: publicRole(storedRole),
        storedRole,
        department: null,
        effectivePermissionCount: access.permissions.size,
        individualGrantCount: own.length,
        canManageUsers: (['users.create', 'users.edit', 'users.deactivate'] as PermissionKey[]).some((k) => hasPermission(access, k)),
        canManagePermissions: hasPermission(access, 'permissions.manage') || hasPermission(access, 'roles.assign'),
        canApproveOrPost: hasPermission(access, 'journals.post') || hasPermission(access, 'fiscal_periods.manage'),
        isDelegate: delegates.has(id),
        lastActivity: auth?.user?.last_sign_in_at ?? null,
        createdAt: String(m.created_at),
      } satisfies UserAccessSummary
    }),
  )
  return rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}

// ------------------------------------------------------------------------------------------------
// Access detail
// ------------------------------------------------------------------------------------------------

export interface AccessHistoryEntry {
  id: string
  action: string
  actorId: string | null
  actorName: string | null
  createdAt: string
  reason: string | null
  before: unknown
  after: unknown
  details: unknown
}

export interface UserAccessDetail {
  userId: string
  name: string | null
  email: string
  role: CompanyRole
  displayRole: string
  isActive: boolean
  roleBaseline: PermissionKey[]
  grants: Array<GrantRecord & { grantedByName: string | null }>
  effective: EffectivePermission[]
  delegation: (DelegationRecord & { grantedByName: string | null }) | null
  warnings: AccessWarning[]
  history: AccessHistoryEntry[]
}

async function namesFor(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => Boolean(i)))]
  const out = new Map<string, string>()
  if (!unique.length) return out
  const { data } = await createAdminClient().from('profiles').select('id, full_name').in('id', unique)
  for (const p of data ?? []) out.set(String(p.id), (p.full_name as string | null) ?? '')
  return out
}

export async function getUserAccessDetail(ctx: AuthorizedContext, userId: string): Promise<UserAccessDetail> {
  const snap = await loadTargetOrThrow(ctx, userId)
  const admin = createAdminClient()
  const { data: authUser } = await admin.auth.admin.getUserById(userId)
  const { data: profile } = await admin.from('profiles').select('full_name').eq('id', userId).maybeSingle()

  const { data: historyRows, error } = await admin
    .from('audit_logs')
    .select('id, action, user_id, created_at, reason, before_state, after_state, details')
    .eq('company_id', ctx.companyId)
    .eq('entity_type', 'user_access')
    .eq('entity_id', userId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error

  const names = await namesFor([
    ...snap.grants.map((g) => g.grantedBy),
    snap.delegation?.grantedBy,
    ...(historyRows ?? []).map((h) => h.user_id as string | null),
  ])

  return {
    userId,
    name: (profile?.full_name as string | null) ?? null,
    email: authUser?.user?.email ?? '',
    role: snap.role,
    displayRole: publicRole(snap.role),
    isActive: snap.isActive,
    roleBaseline: ROLE_BASELINES[snap.role],
    grants: snap.grants.map((g) => ({ ...g, grantedByName: g.grantedBy ? names.get(g.grantedBy) ?? null : null })),
    effective: listEffective(snap.access),
    delegation: snap.delegation
      ? { ...snap.delegation, grantedByName: snap.delegation.grantedBy ? names.get(snap.delegation.grantedBy) ?? null : null }
      : null,
    warnings: analyzeAccess(snap.access, snap.grants.map((g) => g.permission)),
    history: (historyRows ?? []).map((h) => ({
      id: String(h.id),
      action: String(h.action),
      actorId: (h.user_id as string | null) ?? null,
      actorName: h.user_id ? names.get(String(h.user_id)) ?? null : null,
      createdAt: String(h.created_at),
      reason: (h.reason as string | null) ?? null,
      before: h.before_state,
      after: h.after_state,
      details: h.details,
    })),
  }
}

export async function previewUserAccess(ctx: AuthorizedContext, userId: string, input: { role?: unknown; grant?: unknown; revoke?: unknown }): Promise<AccessPreview> {
  const snap = await loadTargetOrThrow(ctx, userId)
  const change: AccessChange = {}
  if (input.role !== undefined && input.role !== null && input.role !== '') change.role = parseRole(input.role)
  if (Array.isArray(input.grant)) change.addGrants = input.grant.filter(isPermissionKey).map((permission) => ({ permission }))
  if (Array.isArray(input.revoke)) change.revokeGrants = input.revoke.filter(isPermissionKey)
  return previewAccessChange({ role: snap.role, grants: snap.grants }, change)
}

// ------------------------------------------------------------------------------------------------
// Mutations (every one: assert authority → apply → audit)
// ------------------------------------------------------------------------------------------------

export async function createUserAsActor(
  ctx: AuthorizedContext,
  input: { email?: string; password?: string; name?: string | null; role?: unknown },
  req?: Request,
) {
  if (!input.email || !input.password) throw new ValidationError('email and password required')
  const role = parseRole(input.role ?? 'ACCOUNTANT')
  await guardAccessChange(ctx, 'create_user', null, req, () => assertCanCreateUser(ctx.principal, role))

  const user = await createAppUser({
    name: input.name,
    email: input.email,
    password: input.password,
    role,
    companyId: ctx.companyId,
  })
  await logAudit({
    companyId: ctx.companyId,
    userId: ctx.id,
    action: 'USER_CREATED',
    entityType: 'user_access',
    entityId: user.id,
    after: { email: user.email, role },
    ipAddress: req ? extractClientIp(req) : null,
  })
  return user
}

export async function updateUserAsActor(
  ctx: AuthorizedContext,
  userId: string,
  input: { name?: string | null; role?: unknown; isActive?: boolean | null; password?: string | null },
  req?: Request,
) {
  const snap = await loadTargetOrThrow(ctx, userId)
  const target = toTarget(snap)
  const changingRole = input.role !== undefined && input.role !== null
  const nextRole = changingRole ? parseRole(input.role) : snap.role
  const changingActive = input.isActive !== undefined && input.isActive !== null && input.isActive !== snap.isActive
  const changingProfile = input.name !== undefined || Boolean(input.password)

  await guardAccessChange(ctx, 'update_user', userId, req, () => {
    if (changingProfile) assertCanEditUser(ctx.principal, target)
    if (changingRole && nextRole !== snap.role) assertCanAssignRole(ctx.principal, target, nextRole)
    if (changingActive) assertCanDeactivateUser(ctx.principal, target)
    if (!changingProfile && !changingActive && !(changingRole && nextRole !== snap.role)) assertCanEditUser(ctx.principal, target)
  })

  const updated = await updateAppUser(userId, ctx.companyId, {
    name: input.name,
    role: changingRole ? nextRole : undefined,
    isActive: changingActive ? Boolean(input.isActive) : snap.isActive,
    password: input.password,
  })

  const ip = req ? extractClientIp(req) : null
  if (changingRole && nextRole !== snap.role) {
    await logAudit({
      companyId: ctx.companyId, userId: ctx.id, action: 'ROLE_CHANGED', entityType: 'user_access', entityId: userId,
      before: { role: snap.role }, after: { role: nextRole }, ipAddress: ip,
    })
  }
  if (changingActive) {
    await logAudit({
      companyId: ctx.companyId, userId: ctx.id, action: input.isActive ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
      entityType: 'user_access', entityId: userId, before: { isActive: snap.isActive }, after: { isActive: Boolean(input.isActive) }, ipAddress: ip,
    })
  }
  if (changingProfile) {
    await logAudit({
      companyId: ctx.companyId, userId: ctx.id, action: 'USER_UPDATED', entityType: 'user_access', entityId: userId,
      // The password itself is never recorded — only the fact that it was reset.
      details: { nameChanged: input.name !== undefined, passwordReset: Boolean(input.password) }, ipAddress: ip,
    })
  }
  return updated
}

export async function deleteUserAsActor(ctx: AuthorizedContext, userId: string, req?: Request) {
  if (userId === ctx.id) throw new ValidationError('Cannot delete your own account')
  const snap = await loadTargetOrThrow(ctx, userId)
  await guardAccessChange(ctx, 'delete_user', userId, req, () => assertCanDeactivateUser(ctx.principal, toTarget(snap)))
  await deleteAppUser(userId, ctx.companyId)
  await logAudit({
    companyId: ctx.companyId, userId: ctx.id, action: 'USER_DELETED', entityType: 'user_access', entityId: null,
    before: { userId, role: snap.role }, ipAddress: req ? extractClientIp(req) : null,
  })
}

export async function grantPermissionAsActor(
  ctx: AuthorizedContext,
  userId: string,
  input: { permission?: unknown; scope?: unknown; reason?: unknown },
  req?: Request,
) {
  if (!isPermissionKey(input.permission)) throw new ValidationError('Unknown permission')
  const permission = input.permission
  const snap = await loadTargetOrThrow(ctx, userId)
  await guardAccessChange(ctx, `grant:${permission}`, userId, req, () => assertCanChangeGrant(ctx.principal, toTarget(snap), permission))

  const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : null
  let scope: PermissionScope | null = null
  if (input.scope && typeof input.scope === 'object') {
    const ids = (input.scope as { costCenterIds?: unknown }).costCenterIds
    if (Array.isArray(ids) && ids.length) {
      const costCenterIds = ids.filter((i): i is string => typeof i === 'string')
      const { data, error } = await createAdminClient().from('cost_centers').select('id').eq('company_id', ctx.companyId).in('id', costCenterIds)
      if (error) throw error
      if ((data ?? []).length !== costCenterIds.length) throw new ValidationError('Scope references unknown cost centers')
      scope = { costCenterIds }
    }
  }

  if (snap.access.permissions.get(permission)?.sources.some((s) => s !== 'grant')) {
    throw new ValidationError('The role already provides this permission')
  }

  const admin = createAdminClient()
  // Replace any existing active grant for this permission so scope changes keep a history row.
  const existing = snap.grants.find((g) => g.permission === permission)
  if (existing) {
    const { error: revokeError } = await admin
      .from('user_permission_grants')
      .update({ revoked_at: new Date().toISOString(), revoked_by: ctx.id, revoke_reason: 'Superseded by new grant' })
      .eq('id', existing.id)
      .eq('company_id', ctx.companyId)
    if (revokeError) throw revokeError
  }
  const { error } = await admin.from('user_permission_grants').insert({
    company_id: ctx.companyId,
    user_id: userId,
    permission,
    scope,
    granted_by: ctx.id,
    reason,
  })
  if (error) throw error

  await logAudit({
    companyId: ctx.companyId, userId: ctx.id, action: 'PERMISSION_GRANTED', entityType: 'user_access', entityId: userId,
    before: existing ? { scope: existing.scope ?? null } : null, after: { permission, scope }, reason,
    ipAddress: req ? extractClientIp(req) : null,
  })
}

export async function revokePermissionAsActor(ctx: AuthorizedContext, userId: string, permissionInput: unknown, reasonInput: unknown, req?: Request) {
  if (!isPermissionKey(permissionInput)) throw new ValidationError('Unknown permission')
  const permission = permissionInput
  const snap = await loadTargetOrThrow(ctx, userId)
  await guardAccessChange(ctx, `revoke:${permission}`, userId, req, () => assertCanChangeGrant(ctx.principal, toTarget(snap), permission))
  const existing = snap.grants.find((g) => g.permission === permission)
  if (!existing) throw new NotFoundError('No individual grant to revoke')

  const reason = typeof reasonInput === 'string' && reasonInput.trim() ? reasonInput.trim().slice(0, 500) : null
  const { error } = await createAdminClient()
    .from('user_permission_grants')
    .update({ revoked_at: new Date().toISOString(), revoked_by: ctx.id, revoke_reason: reason })
    .eq('id', existing.id)
    .eq('company_id', ctx.companyId)
    .is('revoked_at', null)
  if (error) throw error

  await logAudit({
    companyId: ctx.companyId, userId: ctx.id, action: 'PERMISSION_REVOKED', entityType: 'user_access', entityId: userId,
    before: { permission, scope: existing.scope ?? null }, reason, ipAddress: req ? extractClientIp(req) : null,
  })
}

export async function setDelegationAsOwner(
  ctx: AuthorizedContext,
  userId: string,
  input: { manageableRoles?: unknown; delegable?: unknown; note?: unknown },
  req?: Request,
): Promise<Delegation> {
  await guardAccessChange(ctx, 'set_delegation', userId, req, () => assertCanManageDelegations(ctx.principal))
  const snap = await loadTargetOrThrow(ctx, userId)
  if (snap.role === 'OWNER') throw new AccessDeniedError('target_is_owner', 'The owner cannot be a delegate.')
  if (!snap.isActive) throw new ValidationError('Cannot delegate to a deactivated user')
  const delegation = normalizeDelegation(input)
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) || null : null

  const admin = createAdminClient()
  if (snap.delegation) {
    const { error } = await admin
      .from('access_delegations')
      .update({ revoked_at: new Date().toISOString(), revoked_by: ctx.id })
      .eq('id', snap.delegation.id)
      .eq('company_id', ctx.companyId)
    if (error) throw error
  }
  const { error } = await admin.from('access_delegations').insert({
    company_id: ctx.companyId,
    user_id: userId,
    manageable_roles: delegation.manageableRoles,
    delegable_permissions: delegation.delegable,
    granted_by: ctx.id,
    note,
  })
  if (error) throw error

  await logAudit({
    companyId: ctx.companyId, userId: ctx.id, action: 'DELEGATION_SET', entityType: 'user_access', entityId: userId,
    before: snap.delegation ? { manageableRoles: snap.delegation.manageableRoles, delegable: snap.delegation.delegable } : null,
    after: { manageableRoles: delegation.manageableRoles, delegable: delegation.delegable }, reason: note,
    ipAddress: req ? extractClientIp(req) : null,
  })
  return delegation
}

export async function revokeDelegationAsOwner(ctx: AuthorizedContext, userId: string, req?: Request) {
  await guardAccessChange(ctx, 'revoke_delegation', userId, req, () => assertCanManageDelegations(ctx.principal))
  const snap = await loadTargetOrThrow(ctx, userId)
  if (!snap.delegation) throw new NotFoundError('No active delegation')
  const { error } = await createAdminClient()
    .from('access_delegations')
    .update({ revoked_at: new Date().toISOString(), revoked_by: ctx.id })
    .eq('id', snap.delegation.id)
    .eq('company_id', ctx.companyId)
    .is('revoked_at', null)
  if (error) throw error
  await logAudit({
    companyId: ctx.companyId, userId: ctx.id, action: 'DELEGATION_REVOKED', entityType: 'user_access', entityId: userId,
    before: { manageableRoles: snap.delegation.manageableRoles, delegable: snap.delegation.delegable },
    ipAddress: req ? extractClientIp(req) : null,
  })
}

/** Maps domain errors to HTTP responses without leaking internals. */
export function accessErrorResponse(error: unknown): Response | null {
  if (error instanceof AccessDeniedError) return Response.json({ error: error.message, code: error.reason }, { status: 403 })
  if (error instanceof NotFoundError) return Response.json({ error: error.message }, { status: 404 })
  if (error instanceof ValidationError) return Response.json({ error: error.message }, { status: 400 })
  return null
}
