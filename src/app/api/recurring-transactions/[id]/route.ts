import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse, ForbiddenError } from '@/lib/authz'
import { getRecurringTemplate, softDeleteRecurringTemplate, updateRecurringTemplate } from '@/lib/recurring-transactions/service'
import { requireRecurringPermission } from '@/lib/recurring-transactions/permissions'

function recurringError(error: unknown) {
  if (error instanceof ForbiddenError || (error instanceof Error && error.message === 'Unauthorized')) return authzErrorResponse(error)
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({ error: message }, { status: /required|invalid|not found|must be/i.test(message) ? 400 : 500 })
}

async function handleGet(_request: Request, context: RouteContext<'/api/recurring-transactions/[id]'>) {
  try {
    const user = await requireAuth(); const access = await requireRecurringPermission(user, 'view')
    const { id } = await context.params
    const template = await getRecurringTemplate(access.companyId, id)
    return template ? Response.json(template) : Response.json({ error: 'Not found' }, { status: 404 })
  } catch (error) { return recurringError(error) }
}

async function handlePut(request: Request, context: RouteContext<'/api/recurring-transactions/[id]'>) {
  try {
    const user = await requireAuth(); const access = await requireRecurringPermission(user, 'edit')
    const { id } = await context.params
    const template = await updateRecurringTemplate(access.companyId, user.id, id, await request.json())
    return template ? Response.json(template) : Response.json({ error: 'Not found' }, { status: 404 })
  } catch (error) { return recurringError(error) }
}

async function handleDelete(_request: Request, context: RouteContext<'/api/recurring-transactions/[id]'>) {
  try {
    const user = await requireAuth(); const access = await requireRecurringPermission(user, 'delete')
    const { id } = await context.params
    const removed = await softDeleteRecurringTemplate(access.companyId, user.id, id)
    return removed ? Response.json({ success: true }) : Response.json({ error: 'Not found' }, { status: 404 })
  } catch (error) { return recurringError(error) }
}

export const GET = guarded(['invoices.view', 'bills.view', 'expenses.view'], handleGet)
export const PUT = guarded(['invoices.edit', 'bills.edit', 'expenses.edit'], handlePut)
export const DELETE = guarded(['invoices.edit', 'bills.edit', 'expenses.edit'], handleDelete)
