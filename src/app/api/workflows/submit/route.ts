import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { submitWorkflow, WorkflowError } from '@/lib/workflow/engine'
import type { WorkflowEntityType } from '@/lib/workflow/types'

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()

    const instance = await submitWorkflow({
      entityType: body.entityType as WorkflowEntityType,
      entityId: body.entityId,
      entityLabel: body.entityLabel,
      amount: body.amount != null ? Number(body.amount) : undefined,
      departmentId: body.departmentId ?? null,
      submittedById: user.id,
      templateId: body.templateId,
      metadata: body.metadata,
    })

    if (!instance) {
      return Response.json({ message: 'No workflow binding matched' }, { status: 204 })
    }

    return Response.json(instance, { status: 201 })
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
