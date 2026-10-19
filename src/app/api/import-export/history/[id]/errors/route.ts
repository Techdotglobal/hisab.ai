import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { buildErrorReport } from '@/lib/import-export/import/error-report'
import { getImportJobErrors } from '@/lib/import-export/jobs/import-job.service'
import { getImportHistoryDetail } from '@/lib/import-export/history/import-history.service'
import { apiError } from '@/lib/import-export/api-helpers'

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params
    const detail = await getImportHistoryDetail(id)
    if (!detail) {
      return Response.json({ error: 'Import history record not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const format = searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv'
    const errors = await getImportJobErrors(id)
    const payload = buildErrorReport(format, errors)

    return new Response(payload.content, {
      headers: {
        'Content-Type': payload.mimeType,
        'Content-Disposition': `attachment; filename="import-errors-${id}.${payload.extension}"`,
      },
    })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
