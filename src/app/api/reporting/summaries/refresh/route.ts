import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { refreshDailySummaries } from '@/lib/reporting/summaries'

async function handlePost() {
  try {
    await requireAuth()
    const result = await refreshDailySummaries()
    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('reports.view', handlePost)
