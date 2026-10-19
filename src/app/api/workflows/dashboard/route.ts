import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { processWorkflowEscalationsAndReminders } from '@/lib/workflow/engine'
import { listUserNotifications } from '@/lib/workflow/notifications'

async function handleGet(request: Request) {
  try {
    const user = await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const view = searchParams.get('view') ?? 'pending'

    await processWorkflowEscalationsAndReminders(companyId)

    const client = createAdminClient()

    if (view === 'notifications') {
      const notifications = await listUserNotifications(user.id, companyId, searchParams.get('unread') === 'true')
      return Response.json({ notifications })
    }

    if (view === 'history') {
      const { data } = await client
        .from('workflow_history')
        .select('*, instance:workflow_instances(entity_type, entity_label, entity_id)')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(100)
      return Response.json({ history: data ?? [] })
    }

    const { data: pendingTasks } = await client
      .from('workflow_tasks')
      .select('*, instance:workflow_instances(*), step:workflow_template_steps(name)')
      .eq('company_id', companyId)
      .eq('assignee_user_id', user.id)
      .eq('status', 'PENDING')
      .order('created_at', { ascending: false })

    const { data: mySubmissions } = await client
      .from('workflow_instances')
      .select('*')
      .eq('company_id', companyId)
      .eq('submitted_by_id', user.id)
      .in('status', ['PENDING', 'IN_PROGRESS'])
      .order('submitted_at', { ascending: false })
      .limit(20)

    const { count: pendingCount } = await client
      .from('workflow_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('assignee_user_id', user.id)
      .eq('status', 'PENDING')

    return Response.json({
      pendingTasks: pendingTasks ?? [],
      mySubmissions: mySubmissions ?? [],
      pendingCount: pendingCount ?? 0,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
