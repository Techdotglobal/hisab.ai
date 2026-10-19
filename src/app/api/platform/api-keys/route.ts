import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse } from '@/lib/authz'
import { createApiKey } from '@/lib/platform/api-keys/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { requirePlatformAdmin } from '@/lib/platform/require-admin'

async function handleGet() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const client = createAdminClient()
    const { data, error } = await client
      .from('api_keys')
      .select('id, name, key_prefix, scopes, rate_limit_per_minute, expires_at, is_active, last_used_at, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return Response.json({ keys: data ?? [] })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requirePlatformAdmin()
    const body = await request.json()
    const key = await createApiKey({
      name: String(body.name ?? 'API Key'),
      scopes: body.scopes ?? ['read'],
      rateLimitPerMinute: body.rateLimitPerMinute,
      expiresAt: body.expiresAt,
      createdById: user.id,
    })
    return Response.json(key, { status: 201 })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export const GET = guarded('integrations.manage', handleGet)
export const POST = guarded('integrations.manage', handlePost)
