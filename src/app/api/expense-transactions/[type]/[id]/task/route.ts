import { guarded } from '@/lib/permissions/guard'
import { requireRole, authzErrorResponse } from '@/lib/authz'
import { logAudit } from '@/lib/audit/log'

async function handlePost(_request: Request, context: { params: Promise<{ type: string; id: string }> }) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const { type, id } = await context.params
    await logAudit({ companyId: user.companyId, userId: user.id, action: 'TASK_CREATE_REQUESTED', entityType: `expense_transaction:${type}`, entityId: id, details: { placeholder: true } })
    return Response.json({ queued: true, message: 'A task-management hook was recorded for this transaction.' }, { status: 202 })
  } catch (error) { return authzErrorResponse(error) }
}

export const POST = guarded('expenses.edit', handlePost)
