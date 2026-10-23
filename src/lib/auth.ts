import { memoPerRequest } from './request-memo'
import { getAppUser, type AppUser } from './supabase/auth-users'
import { createClient } from './supabase/server'
import { TenantAccessError } from './tenant-error'

export type { AppUser }

/** The Supabase Auth user for this request (one Auth call per request when inside a guarded route). */
export function getAuthUser(): Promise<{ id: string; email: string } | null> {
  return memoPerRequest('auth.user', async () => {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user?.email) return null
    return { id: data.user.id, email: data.user.email }
  })
}

export function getSession(): Promise<AppUser | null> {
  return memoPerRequest('auth.session', async () => {
    const authUser = await getAuthUser()
    if (!authUser) return null

    try {
      const user = await getAppUser(authUser.id, authUser.email)
      return user.isActive ? user : null
    } catch (err) {
      if (err instanceof TenantAccessError) {
        return null
      }
      throw err
    }
  })
}

export async function requireAuth(): Promise<AppUser> {
  const user = await getSession()
  if (!user) {
    throw new Error('Unauthorized')
  }
  return user
}
