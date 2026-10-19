import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import {
  approveWorkflowTask,
  rejectWorkflowTask,
  delegateWorkflowTask,
  WorkflowError,
} from '@/lib/workflow/engine'
import { syncDocumentApprovalStatus } from '@/lib/workflow/integration'
import type { WorkflowEntityType } from '@/lib/workflow/types'
import { createAdminClient } from '@/lib/supabase/admin'

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id: taskId } = await params
    const body = await request.json()
    const action = body.action ?? 'approve'

    let task
    if (action === 'reject') {
      task = await rejectWorkflowTask(taskId, { userId: user.id, comments: body.comments })
    } else if (action === 'delegate') {
      if (!body.delegateUserId) {
        return Response.json({ error: 'delegateUserId required' }, { status: 400 })
      }
      task = await delegateWorkflowTask(taskId, body.delegateUserId, {
        userId: user.id,
        comments: body.comments,
      })
    } else {
      task = await approveWorkflowTask(taskId, { userId: user.id, comments: body.comments })
    }

    const client = createAdminClient()
    const rawInstance = (task as { instance?: Record<string, unknown> }).instance
    const fetched = !rawInstance
      ? (await client.from('workflow_tasks').select('instance:workflow_instances(*)').eq('id', taskId).single()).data
      : null
    const instance = (rawInstance ?? fetched?.instance) as Record<string, unknown> | undefined

    if (instance && (action === 'approve' || action === 'reject')) {
      await syncDocumentApprovalStatus(
        String(instance.entity_type) as WorkflowEntityType,
        String(instance.entity_id),
        String(instance.company_id),
      )
    }

    return Response.json({ task, instance })
  } catch (error) {
    if (error instanceof WorkflowError) {
      return Response.json({ error: error.message, code: error.code }, { status: 400 })
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('dashboard.view', handlePost)
