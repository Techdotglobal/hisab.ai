import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse } from '@/lib/authz'
import { requireRecurringPermission } from '@/lib/recurring-transactions/permissions'
import { getRecurringTemplate, listExecutionHistory } from '@/lib/recurring-transactions/service'

async function handleGet(_request: Request, context: RouteContext<'/api/recurring-transactions/[id]/history'>) {
  try {
    const user = await requireAuth(); const access = await requireRecurringPermission(user, 'audit')
    const { id } = await context.params
    const companyId = access.companyId
    if (!await getRecurringTemplate(companyId, id)) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(await listExecutionHistory(companyId, id))
  } catch (error) { return authzErrorResponse(error) }
}

export const GET = guarded(['invoices.view', 'bills.view', 'expenses.view'], handleGet)
