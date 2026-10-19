import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse } from '@/lib/authz'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { emitPlatformEvent } from '@/lib/platform/automation/engine'
import { requirePlatformAdmin } from '@/lib/platform/require-admin'

async function handleGet() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const client = createAdminClient()
    const { data, error } = await client
      .from('automation_rules')
      .select('*')
      .eq('company_id', companyId)
      .order('priority')
    if (error) throw error
    return Response.json({ rules: data ?? [] })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const client = createAdminClient()

    if (body.action === 'emit') {
      await requirePlatformAdmin()
      const results = await emitPlatformEvent({
        eventType: body.eventType,
        companyId,
        entityType: body.entityType,
        entityId: body.entityId,
        payload: body.payload ?? {},
        userId: user.id,
      })
      return Response.json({ results })
    }

    await requirePlatformAdmin()
    const { data, error } = await client
      .from('automation_rules')
      .insert({
        company_id: companyId,
        name: String(body.name ?? 'Automation Rule'),
        description: body.description ?? null,
        event_type: String(body.eventType),
        conditions: body.conditions ?? {},
        actions: body.actions ?? [],
        priority: Number(body.priority ?? 100),
        is_active: body.isActive ?? true,
        created_by_id: user.id,
      })
      .select('*')
      .single()

    if (error) throw error
    return Response.json(data, { status: 201 })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export const GET = guarded('platform.manage', handleGet)
export const POST = guarded('platform.manage', handlePost)
