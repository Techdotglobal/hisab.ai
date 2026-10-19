import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getWorkflowStatus } from '@/lib/workflow/engine'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const entityType = searchParams.get('entityType')
    const entityId = searchParams.get('entityId')
    const companyId = await resolveCompanyId()
    const client = createAdminClient()

    if (entityType && entityId) {
      const instance = await getWorkflowStatus(entityType, entityId, companyId)
      const { data: history } = await client
        .from('workflow_history')
        .select('*')
        .eq('instance_id', instance?.id ?? '00000000-0000-0000-0000-000000000000')
        .order('created_at', { ascending: false })
      return Response.json({ instance, history: history ?? [] })
    }

    const { data, error } = await client
      .from('workflow_instances')
      .select('*')
      .eq('company_id', companyId)
      .order('submitted_at', { ascending: false })
      .limit(100)

    if (error) throw error
    return Response.json(data ?? [])
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
