import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { getImportJob, incrementImportJobRetry } from '@/lib/import-export/jobs/import-job.service'
import { apiError } from '@/lib/import-export/api-helpers'
import { resolveCompanyId } from '@/lib/tenant'
import { enqueueJob } from '@/lib/platform/jobs/queue'

async function handlePost(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    await requireAccountingAdmin(); const { jobId } = await params; const job = await getImportJob(jobId)
    if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
    if (!job.payloadSnapshot) return Response.json({ error: 'Job payload is unavailable.' }, { status: 409 })
    await incrementImportJobRetry(jobId)
    const user = await requireAccountingAdmin()
    const companyId = await resolveCompanyId()
    await enqueueJob({ jobType: 'QUICKBOOKS_IMPORT_STEP', companyId, payload: { importJobId: job.id, moduleKey: job.moduleKey, companyId, userId: user.id } })
    return Response.json({ jobId: job.id, status: 'pending' }, { status: 202 })
  } catch (error) { return apiError(error) }
}

export const POST = guarded('imports.run', handlePost)
