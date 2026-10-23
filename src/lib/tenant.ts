import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { getAppUser } from '@/lib/supabase/auth-users'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAuthUser } from '@/lib/auth'
import { memoPerRequest } from '@/lib/request-memo'
import { TenantAccessError } from '@/lib/tenant-error'
import { AsyncLocalStorage } from 'node:async_hooks'

export { TenantAccessError } from '@/lib/tenant-error'

export const COMPANY_COOKIE = 'hisab_company_id'

const backgroundTenantContext = new AsyncLocalStorage<{ companyId:string }>()

/** Runs trusted background migration work with an already-authorized tenant. */
export function withCompanyContext<T>(companyId:string,operation:()=>T):T{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId))throw new TenantAccessError('A valid company context is required')
  return backgroundTenantContext.run({companyId},operation)
}

async function validateCompanyAccess(userId: string, companyId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('company_users')
    .select('id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error
  return Boolean(data)
}

/** Resolve the authenticated user's active company. Never falls back to a shared/default tenant. */
export async function resolveCompanyId(_client?: SupabaseClient): Promise<string> {
  void _client
  const background=backgroundTenantContext.getStore()
  if(background?.companyId)return background.companyId
  return memoPerRequest('tenant.companyId', async () => {
    const authUser = await getAuthUser()
    if (!authUser) {
      throw new TenantAccessError('Authentication required')
    }

    const cookieStore = await cookies()
    const cookieCompanyId = cookieStore.get(COMPANY_COOKIE)?.value

    if (cookieCompanyId) {
      const allowed = await validateCompanyAccess(authUser.id, cookieCompanyId)
      if (allowed) return cookieCompanyId
    }

    const user = await getAppUser(authUser.id, authUser.email)
    if (!user.companyId) {
      throw new TenantAccessError()
    }
    return user.companyId
  })
}

/** Optional company id for background jobs that already know the tenant. */
export async function resolveCompanyIdOrThrow(companyId?: string): Promise<string> {
  if (companyId) return companyId
  return resolveCompanyId()
}
