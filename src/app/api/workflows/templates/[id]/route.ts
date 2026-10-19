import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const companyId = await resolveCompanyId()
    const client = createAdminClient()

    const { data, error } = await client
      .from('workflow_templates')
      .select(`
        *,
        steps:workflow_template_steps(
          *,
          approvers:workflow_template_step_approvers(*)
        )
      `)
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .single()

    if (error) throw error
    return Response.json(data)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const client = createAdminClient()

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.name !== undefined) patch.name = body.name
    if (body.description !== undefined) patch.description = body.description
    if (body.isActive !== undefined) patch.is_active = body.isActive

    const { data, error } = await client
      .from('workflow_templates')
      .update(patch)
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*')
      .single()

    if (error) throw error
    return Response.json(data)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const companyId = await resolveCompanyId()
    const client = createAdminClient()

    const { error } = await client
      .from('workflow_templates')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) throw error
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
export const PATCH = guarded('workflows.manage', handlePatch)
export const DELETE = guarded('workflows.manage', handleDelete)
