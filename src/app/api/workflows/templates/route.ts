import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { WORKFLOW_ENTITY_TYPES } from '@/lib/workflow/types'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const entityType = searchParams.get('entityType')
    const companyId = await resolveCompanyId()
    const client = createAdminClient()

    let query = client
      .from('workflow_templates')
      .select('*')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('name')

    if (entityType) query = query.eq('entity_type', entityType)

    const { data, error } = await query
    if (error) throw error

    return Response.json({ templates: data ?? [], entityTypes: WORKFLOW_ENTITY_TYPES })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const name = String(body.name ?? '').trim()
    const entityType = String(body.entityType ?? '').trim()

    if (!name || !entityType) {
      return Response.json({ error: 'name and entityType are required' }, { status: 400 })
    }

    const client = createAdminClient()
    const { data, error } = await client
      .from('workflow_templates')
      .insert({
        company_id: companyId,
        name,
        description: body.description ?? null,
        entity_type: entityType,
        is_active: body.isActive ?? true,
        created_by_id: user.id,
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
