import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse, ForbiddenError } from '@/lib/authz'
import { createRecurringTemplate, listRecurringTemplates } from '@/lib/recurring-transactions/service'
import { requireRecurringPermission } from '@/lib/recurring-transactions/permissions'

function recurringError(error: unknown) {
  if (error instanceof ForbiddenError || (error instanceof Error && error.message === 'Unauthorized')) return authzErrorResponse(error)
  const message = error instanceof Error ? error.message : String(error)
  const status = /required|invalid|not found|must be/i.test(message) ? 400 : 500
  return Response.json({ error: message }, { status })
}

async function handleGet(request: Request) {
  try {
    const user = await requireAuth()
    const access = await requireRecurringPermission(user, 'view')
    return Response.json(await listRecurringTemplates(access.companyId, request.url))
  } catch (error) { return recurringError(error) }
}

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const access = await requireRecurringPermission(user, 'create')
    const template = await createRecurringTemplate(access.companyId, user.id, await request.json())
    return Response.json(template, { status: 201 })
  } catch (error) { return recurringError(error) }
}

export const GET = guarded(['invoices.view', 'bills.view', 'expenses.view'], handleGet)
export const POST = guarded(['invoices.edit', 'bills.edit', 'expenses.edit'], handlePost)
