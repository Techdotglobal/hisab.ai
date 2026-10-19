import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { closeFiscalPeriod, listFiscalPeriods } from '@/lib/accounting/fiscal-periods'

async function handleGet() {
  try {
    await requireAuth()
    const periods = await listFiscalPeriods()
    return Response.json(periods)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()
    const { periodId, action } = body

    if (action === 'close' && periodId) {
      const period = await closeFiscalPeriod(periodId, user.id)
      return Response.json(period)
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('accounts.view', handleGet)
export const POST = guarded('fiscal_periods.manage', handlePost)
