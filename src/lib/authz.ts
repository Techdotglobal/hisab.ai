import 'server-only'
import { requireAuth } from '@/lib/auth'
import type { CompanyRole } from '@/lib/db/types'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { OwnershipGuardError } from '@/lib/supabase/auth-users'

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export async function requireRole(roles: CompanyRole[]) {
  const user = await requireAuth()
  const companyId = await resolveCompanyId()
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('company_users')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error
  if (!data || !roles.includes(data.role as CompanyRole)) {
    throw new ForbiddenError()
  }

  return { ...user, companyId, role: data.role as CompanyRole }
}

function serializeAuthzError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    for (const key of ['message', 'error', 'details', 'hint'] as const) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    try {
      return JSON.stringify(error)
    } catch {
      // fall through
    }
  }
  const text = String(error)
  return text === '[object Object]' ? 'Unexpected server error' : text
}

export function authzErrorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (error instanceof ForbiddenError) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (error instanceof OwnershipGuardError) {
    return Response.json({ error: error.message }, { status: 400 })
  }
  return Response.json({ error: serializeAuthzError(error) }, { status: 500 })
}
