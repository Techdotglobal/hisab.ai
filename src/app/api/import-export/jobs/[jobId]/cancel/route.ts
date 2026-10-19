import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin as requireAuth } from '@/lib/product-parity/permissions'
import {
  cancelImportJob,
} from '@/lib/import-export/jobs/import-job.service'
import { apiError } from '@/lib/import-export/api-helpers'

async function handlePost(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    await requireAuth()
    const { jobId } = await params
    const job = await cancelImportJob(jobId)
    if (!job) {
      return Response.json({ error: 'Job not found' }, { status: 404 })
    }
    return Response.json({ id: job.id, status: job.status })
  } catch (error) {
    return apiError(error)
  }
}

export const POST = guarded('imports.run', handlePost)
