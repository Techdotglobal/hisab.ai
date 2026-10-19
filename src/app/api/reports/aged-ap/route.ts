import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { buildAgedPayablesReport } from '@/lib/reporting/aging'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const asOf = searchParams.get('asOf') ? new Date(searchParams.get('asOf')!) : new Date()
    const report = await buildAgedPayablesReport(asOf)
    return Response.json(report)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('reports.view', handleGet)
