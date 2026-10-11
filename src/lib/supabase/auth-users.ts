import 'server-only'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_CURRENCY, normalizeCurrency } from '@/lib/currency/constants'
import type { CompanyRole } from '@/lib/db/types'
import { TenantAccessError } from '@/lib/tenant-error'
import { getSupabaseAnonKey, getSupabaseUrl } from './env'
import { createAdminClient } from './admin'

export interface AppUser {
  id: string
  name: string | null
  email: string
  role: string
  companyId: string
  companyName: string
  country: string
  currency: string
  avatarUrl: string | null
  isActive: boolean
}

/**
 * Every assignable role EXCEPT OWNER. Ownership is never set by the generic create/update
 * path — only `transferCompanyOwnership` can produce an OWNER row, so a company can never
 * end up with an extra or an accidental owner through user management.
 */
export const ASSIGNABLE_NON_OWNER_ROLES: CompanyRole[] = ['ADMIN', 'ACCOUNTANT', 'MANAGER', 'EMPLOYEE', 'AUDITOR']

// OWNER stays accepted here for registration (new-company signup sets the first member to
// OWNER directly). It is never reachable through user management: createAppUser and
// updateAppUser both reject an OWNER/SUPER_ADMIN role explicitly before this is called.
export function toCompanyRole(role: string | null | undefined): CompanyRole {
  if (role === 'ADMIN' || role === 'ACCOUNTANT' || role === 'OWNER' || role === 'MANAGER' || role === 'EMPLOYEE') {
    return role
  }
  return 'AUDITOR'
}

/** Display role for the UI. OWNER displays as Super Admin, same convention as AUDITOR/VIEWER. */
export function publicRole(role: string | null | undefined): string {
  if (role === 'OWNER') return 'SUPER_ADMIN'
  return role === 'AUDITOR' ? 'VIEWER' : role || 'ACCOUNTANT'
}

/** Maps a UI display role back to its stored company_role. Never produces OWNER — rejects it explicitly. */
export function fromDisplayRole(role: string): CompanyRole {
  if (role === 'VIEWER') return 'AUDITOR'
  if (role === 'OWNER' || role === 'SUPER_ADMIN') {
    throw new OwnershipGuardError('Owner can only be assigned through the ownership transfer action.')
  }
  if (ASSIGNABLE_NON_OWNER_ROLES.includes(role as CompanyRole)) return role as CompanyRole
  throw new Error(`Unknown role: ${role}`)
}

export class OwnershipGuardError extends Error {
  constructor(message = 'Use the ownership transfer action to change or deactivate the Owner.') {
    super(message)
    this.name = 'OwnershipGuardError'
  }
}

export function createPasswordAuthClient() {
  return createSupabaseClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

async function resolvePrimaryCompanyId(userId: string): Promise<string> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('company_users')
    .select('company_id, role, created_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })

  if (error) throw error
  if (!data?.length) {
    throw new TenantAccessError('This account is not linked to a company. Register a new company or accept an invitation.')
  }

  const ownerMemberships = data.filter((row) => row.role === 'OWNER')
  if (ownerMemberships.length > 0) {
    return String(ownerMemberships[ownerMemberships.length - 1].company_id)
  }

  return String(data[data.length - 1].company_id)
}

export async function upsertProfileAndMembership(input: {
  userId: string
  email: string
  name?: string | null
  role?: string | null
  isActive?: boolean
  companyId: string
}) {
  const admin = createAdminClient()

  const { error: profileError } = await admin
    .from('profiles')
    .upsert(
      {
        id: input.userId,
        full_name: input.name ?? input.email.split('@')[0],
        is_active: input.isActive ?? true,
      },
      { onConflict: 'id' },
    )
  if (profileError) throw profileError

  const { error: membershipError } = await admin
    .from('company_users')
    .upsert(
      {
        company_id: input.companyId,
        user_id: input.userId,
        role: toCompanyRole(input.role),
        is_active: input.isActive ?? true,
      },
      { onConflict: 'company_id,user_id' },
    )
  if (membershipError) throw membershipError
}

export async function getAppUser(userId: string, email: string): Promise<AppUser> {
  const admin = createAdminClient()
  const companyId = await resolvePrimaryCompanyId(userId)

  const [{ data: profile, error: profileError }, { data: membership, error: membershipError }, { data: company, error: companyError }] =
    await Promise.all([
      admin.from('profiles').select('full_name, avatar_url, is_active').eq('id', userId).maybeSingle(),
      admin
        .from('company_users')
        .select('role, is_active')
        .eq('company_id', companyId)
        .eq('user_id', userId)
        .maybeSingle(),
      admin
        .from('companies')
        .select('company_name, country, currency')
        .eq('id', companyId)
        .maybeSingle(),
    ])

  if (profileError) throw profileError
  if (membershipError) throw membershipError
  if (companyError) throw companyError
  if (!membership) {
    throw new TenantAccessError('Company membership not found for this account.')
  }

  return {
    id: userId,
    name: (profile?.full_name as string | null | undefined) ?? email.split('@')[0],
    email,
    companyId,
    companyName: company?.company_name ?? 'Company',
    country: String(company?.country ?? 'Saudi Arabia'),
    currency: normalizeCurrency(String(company?.currency ?? DEFAULT_CURRENCY)),
    avatarUrl: (profile?.avatar_url as string | null | undefined) ?? null,
    role: publicRole((membership?.role as string | null | undefined) ?? 'ACCOUNTANT'),
    isActive: Boolean((profile?.is_active ?? true) && (membership?.is_active ?? true)),
  }
}

export async function listAppUsers(companyId: string): Promise<(AppUser & { createdAt: string })[]> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('company_users')
    .select('user_id, role, is_active, created_at, profiles(full_name, avatar_url, is_active)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })

  if (error) throw error

  const { data: companyRow, error: companyError } = await admin
    .from('companies')
    .select('company_name, country, currency')
    .eq('id', companyId)
    .maybeSingle()
  if (companyError) throw companyError

  const users = await Promise.all(
    (data ?? []).map(async (row) => {
      const { data: authUser, error: authError } = await admin.auth.admin.getUserById(String(row.user_id))
      if (authError) throw authError

      const profile = row.profiles as {
        full_name?: string | null
        avatar_url?: string | null
        is_active?: boolean | null
      } | null
      const userEmail = authUser.user.email ?? ''

      return {
        id: String(row.user_id),
        name: profile?.full_name ?? userEmail.split('@')[0],
        email: userEmail,
        companyId,
        companyName: companyRow?.company_name ?? 'Company',
        country: String(companyRow?.country ?? 'Saudi Arabia'),
        currency: normalizeCurrency(String(companyRow?.currency ?? DEFAULT_CURRENCY)),
        avatarUrl: profile?.avatar_url ?? null,
        role: publicRole(row.role as string | null),
        isActive: Boolean((row.is_active ?? true) && (profile?.is_active ?? true)),
        createdAt: String(row.created_at),
      }
    }),
  )

  return users.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}

export async function createAppUser(input: {
  email: string
  password: string
  name?: string | null
  role?: string | null
  companyId: string
}): Promise<AppUser & { createdAt: string }> {
  if (input.role === 'OWNER' || input.role === 'SUPER_ADMIN') {
    throw new OwnershipGuardError('A new user cannot be created as Owner — transfer ownership to an existing user instead.')
  }
  // Flow B (invite): joins an existing tenant. Never creates a new company.
  const admin = createAdminClient()
  const { data, error } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      full_name: input.name ?? input.email.split('@')[0],
      role: publicRole(input.role),
    },
  })
  if (error) throw error
  if (!data.user.email) throw new Error('User email is missing')

  await upsertProfileAndMembership({
    userId: data.user.id,
    email: data.user.email,
    name: input.name ?? null,
    role: input.role ?? 'ACCOUNTANT',
    companyId: input.companyId,
    isActive: true,
  })

  const user = await getAppUser(data.user.id, data.user.email)
  return { ...user, createdAt: new Date().toISOString() }
}

export async function updateAppUser(
  userId: string,
  companyId: string,
  input: { name?: string | null; role?: string | null; isActive?: boolean | null; password?: string | null },
): Promise<AppUser> {
  const admin = createAdminClient()
  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(userId)
  if (authError) throw authError
  if (!authUser.user.email) throw new Error('User email is missing')

  // Read the actual stored role rather than the display string in auth metadata — that
  // string is already public-mapped (e.g. SUPER_ADMIN/VIEWER) and re-deriving a company_role
  // from it would silently mis-map on every update that doesn't explicitly pass a role.
  const { data: currentMembership, error: membershipFetchError } = await admin
    .from('company_users')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  if (membershipFetchError) throw membershipFetchError
  const currentRole = (currentMembership?.role as CompanyRole | undefined) ?? 'ACCOUNTANT'

  if (input.role === 'OWNER' || input.role === 'SUPER_ADMIN') {
    throw new OwnershipGuardError('Owner can only be assigned through the ownership transfer action.')
  }
  if (currentRole === 'OWNER' && (input.role !== undefined || input.isActive === false)) {
    throw new OwnershipGuardError()
  }

  const nextRole: CompanyRole = input.role !== undefined ? toCompanyRole(input.role) : currentRole

  const updateData: Parameters<typeof admin.auth.admin.updateUserById>[1] = {
    user_metadata: {
      ...(authUser.user.user_metadata ?? {}),
      full_name: input.name ?? authUser.user.user_metadata?.full_name,
      role: publicRole(nextRole),
    },
  }
  if (input.password) updateData.password = input.password

  const { error: updateError } = await admin.auth.admin.updateUserById(userId, updateData)
  if (updateError) throw updateError

  await upsertProfileAndMembership({
    userId,
    email: authUser.user.email,
    name: input.name ?? authUser.user.user_metadata?.full_name ?? null,
    role: nextRole,
    isActive: input.isActive ?? true,
    companyId,
  })

  return getAppUser(userId, authUser.user.email)
}

export async function deleteAppUser(userId: string, companyId: string) {
  const admin = createAdminClient()
  const { data: membership, error: membershipError } = await admin
    .from('company_users')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  if (membershipError) throw membershipError
  if (membership?.role === 'OWNER') {
    throw new OwnershipGuardError('Transfer ownership to another user before deleting the Owner.')
  }

  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error) throw error
}

/**
 * Atomically moves OWNER from the current owner to an existing, active member of the same
 * company, and assigns the previous owner a new non-owner role in the same operation — a
 * company is never without an owner and never has more than one. Implemented as a Postgres
 * function (migration 080) so both row updates and the one-owner invariant check happen
 * under a single row lock, safe against a concurrent transfer call.
 */
export async function transferCompanyOwnership(input: {
  companyId: string
  newOwnerUserId: string
  previousOwnerNewRole: CompanyRole
}): Promise<void> {
  if (!ASSIGNABLE_NON_OWNER_ROLES.includes(input.previousOwnerNewRole)) {
    throw new Error(`previousOwnerNewRole must be one of: ${ASSIGNABLE_NON_OWNER_ROLES.join(', ')}`)
  }
  const admin = createAdminClient()
  const { error } = await admin.rpc('transfer_company_ownership', {
    p_company_id: input.companyId,
    p_new_owner_user_id: input.newOwnerUserId,
    p_previous_owner_new_role: input.previousOwnerNewRole,
  })
  if (error) throw error
}

export async function userHasCompanyMembership(userId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { count, error } = await admin
    .from('company_users')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_active', true)

  if (error) throw error
  return (count ?? 0) > 0
}
