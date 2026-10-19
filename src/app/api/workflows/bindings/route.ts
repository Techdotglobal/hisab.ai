import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const client = createAdminClient()
    const { data, error } = await client
      .from('workflow_bindings')
      .select('*, template:workflow_templates(id, name, entity_type)')
      .eq('company_id', companyId)
      .order('priority')

    if (error) throw error
    return Response.json(data ?? [])
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const client = createAdminClient()

    const { data, error } = await client
      .from('workflow_bindings')
      .insert({
        company_id: companyId,
        entity_type: body.entityType,
        template_id: body.templateId,
        priority: Number(body.priority ?? 100),
        conditions: body.conditions ?? {},
        is_active: body.isActive ?? true,
      })
      .select('*')
      .single()

    if (error) throw error
    return Response.json(data, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
export const POST = guarded('workflows.manage', handlePost)
