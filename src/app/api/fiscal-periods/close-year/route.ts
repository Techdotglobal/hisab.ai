import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { closeFiscalYear } from '@/lib/accounting/year-close'
import { extractClientIp } from '@/lib/accounting/posting-audit'

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()
    const { periodId, reason } = body

    if (!periodId) {
      return Response.json({ error: 'periodId is required' }, { status: 400 })
    }

    const result = await closeFiscalYear({
      periodId,
      userId: user.id,
      reason: typeof reason === 'string' ? reason : undefined,
      ipAddress: extractClientIp(request),
    })

    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('fiscal_periods.manage', handlePost)
