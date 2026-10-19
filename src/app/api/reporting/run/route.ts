import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { runReport } from '@/lib/reporting/runner'
import { runCustomDefinition } from '@/lib/reporting/custom'
import type { ReportRunRequest } from '@/lib/reporting/types'

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const body = await request.json() as ReportRunRequest & { definitionId?: string }

    if (!body.reportKey && !body.definitionId) {
      return Response.json({ error: 'reportKey or definitionId required' }, { status: 400 })
    }

    const result = body.definitionId
      ? await runCustomDefinition(body.definitionId, body)
      : await runReport(body)

    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const reportKey = searchParams.get('reportKey')
    if (!reportKey) {
      return Response.json({ error: 'reportKey required' }, { status: 400 })
    }

    const result = await runReport({
      reportKey,
      period: searchParams.get('from') && searchParams.get('to')
        ? { from: searchParams.get('from')!, to: searchParams.get('to')!, preset: 'custom' }
        : undefined,
      asOf: searchParams.get('asOf') ?? undefined,
      page: searchParams.get('page') ? Number(searchParams.get('page')) : 1,
      pageSize: searchParams.get('pageSize') ? Number(searchParams.get('pageSize')) : 50,
    })

    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('reports.view', handleGet)
export const POST = guarded('reports.view', handlePost)
