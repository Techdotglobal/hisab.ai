import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { generateWebhookSecret, hashSecret } from '@/lib/platform/webhooks/delivery'
import { requirePlatformAdmin } from '@/lib/platform/require-admin'
import { isSafeWebhookUrl } from '@/lib/security/ssrf'

async function handleGet() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const client = createAdminClient()
    const { data: endpoints } = await client
      .from('webhook_endpoints')
      .select('*')
      .eq('company_id', companyId)
      .order('name')

    const { data: deliveries } = await client
      .from('webhook_deliveries')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(50)

    return Response.json({ endpoints: endpoints ?? [], deliveries: deliveries ?? [] })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

async function handlePost(request: Request) {
  try {
    await requirePlatformAdmin()
    const companyId = await resolveCompanyId()
    const body = await request.json()

    const urlCheck = isSafeWebhookUrl(String(body.url))
    if (!urlCheck.ok) {
      return Response.json({ error: urlCheck.reason }, { status: 400 })
    }

    const client = createAdminClient()

    const secret = generateWebhookSecret()
    const { data, error } = await client
      .from('webhook_endpoints')
      .insert({
        company_id: companyId,
        name: String(body.name),
        direction: body.direction ?? 'OUTGOING',
        url: String(body.url),
        secret_hash: hashSecret(secret),
        events: body.events ?? ['*'],
        is_active: body.isActive ?? true,
      })
      .select('id, name, url, direction, events, version, is_active, created_at')
      .single()

    if (error) throw error
    return Response.json({ ...data, secret }, { status: 201 })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export const GET = guarded('integrations.manage', handleGet)
export const POST = guarded('integrations.manage', handlePost)
