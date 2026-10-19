import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { listImportHistory } from '@/lib/import-export/history/import-history.service'
import { apiError, parseBooleanParam, parseListParam } from '@/lib/import-export/api-helpers'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)

    const result = await listImportHistory({
      page: Number(searchParams.get('page') ?? '1'),
      limit: Number(searchParams.get('limit') ?? '25'),
      search: searchParams.get('search') ?? undefined,
      module: searchParams.get('module') ?? undefined,
      status: parseListParam(searchParams.get('status')),
      dateFrom: searchParams.get('dateFrom') ?? undefined,
      dateTo: searchParams.get('dateTo') ?? undefined,
      sortBy: searchParams.get('sortBy') ?? 'created_at',
      sortDir: searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc',
      includeActive: parseBooleanParam(searchParams.get('includeActive'), false),
    })

    return Response.json(result)
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
