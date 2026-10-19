import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse } from '@/lib/authz'
import { requireRecurringPermission } from '@/lib/recurring-transactions/permissions'
import { duplicateRecurringTemplate } from '@/lib/recurring-transactions/service'

async function handlePost(_request: Request, context: RouteContext<'/api/recurring-transactions/[id]/duplicate'>) {
  try {
    const user = await requireAuth(); const access = await requireRecurringPermission(user, 'create')
    const { id } = await context.params
    const template = await duplicateRecurringTemplate(access.companyId, user.id, id)
    return template ? Response.json(template, { status: 201 }) : Response.json({ error: 'Not found' }, { status: 404 })
  } catch (error) { return authzErrorResponse(error) }
}

export const POST = guarded(['invoices.edit', 'bills.edit', 'expenses.edit'], handlePost)
