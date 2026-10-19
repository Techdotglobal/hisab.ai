import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { buildErrorReport } from '@/lib/import-export/import/error-report'
import { getImportJobErrors } from '@/lib/import-export/jobs/import-job.service'
import { getImportJob } from '@/lib/import-export/jobs/import-job.service'
import { apiError } from '@/lib/import-export/api-helpers'

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    await requireAuth()
    const { jobId } = await params
    const job = await getImportJob(jobId)
    if (!job) {
      return Response.json({ error: 'Job not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const format = searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv'
    const errors = await getImportJobErrors(jobId)
    const payload = buildErrorReport(format, errors)

    return new Response(payload.content, {
      headers: {
        'Content-Type': payload.mimeType,
        'Content-Disposition': `attachment; filename="import-errors-${jobId}.${payload.extension}"`,
      },
    })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
