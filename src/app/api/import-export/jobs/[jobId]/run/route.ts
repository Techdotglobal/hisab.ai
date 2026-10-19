import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { getImportJob } from '@/lib/import-export/jobs/import-job.service'
import { resolveCompanyId } from '@/lib/tenant'
import { apiError } from '@/lib/import-export/api-helpers'
import { enqueueJob } from '@/lib/platform/jobs/queue'
import { logger } from '@/lib/ops/logger'
import { createAdminClient } from '@/lib/supabase/admin'

const TERMINAL_IMPORT_STATUSES = new Set(['completed', 'failed', 'cancelled'])

async function handlePost(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await requireAccountingAdmin(); const { jobId } = await params; const job = await getImportJob(jobId)
    if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
    if (!job.payloadSnapshot) return Response.json({ error: 'Job payload is unavailable.' }, { status: 409 })
    if (TERMINAL_IMPORT_STATUSES.has(job.status)) {
      return Response.json({ jobId: job.id, status: job.status, totalRows: job.totalRows, processedRows: job.processedRows })
    }
    const companyId = await resolveCompanyId()
    const client = createAdminClient()
    const { data: activeQueueJob, error: activeQueueError } = await client
      .from('job_queue')
      .select('id,status')
      .eq('company_id', companyId)
      .eq('job_type', 'QUICKBOOKS_IMPORT_STEP')
      .in('status', ['PENDING', 'RUNNING'])
      .contains('payload', { importJobId: job.id })
      .limit(1)
      .maybeSingle()
    if (activeQueueError) throw activeQueueError
    if (activeQueueJob) {
      return Response.json({
        jobId: job.id,
        platformJobId: activeQueueJob.id,
        status: job.status,
        totalRows: job.totalRows,
        processedRows: job.processedRows,
      }, { status: 202 })
    }
    const queued = await enqueueJob({ jobType: 'QUICKBOOKS_IMPORT_STEP', companyId, payload: { importJobId: job.id, moduleKey: job.moduleKey, companyId, userId: user.id } })
    const persistedJob = await getImportJob(jobId)
    if (!persistedJob) return Response.json({ error: 'Job not found' }, { status: 404 })
    logger.info('quickbooks.worker.import_step.enqueued', { platformJobId: String(queued.id), importJobId: job.id, companyId, userId: user.id, module: job.moduleKey })
    return Response.json({ jobId: persistedJob.id, platformJobId: queued.id, status: persistedJob.status, totalRows: persistedJob.totalRows, processedRows: persistedJob.processedRows }, { status: 202 })
  } catch (error) { return apiError(error) }
}

export const POST = guarded('imports.run', handlePost)
