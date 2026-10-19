import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getImportJob } from '@/lib/import-export/jobs/import-job.service'
import { apiError } from '@/lib/import-export/api-helpers'
import { logger } from '@/lib/ops/logger'

export const dynamic = 'force-dynamic'
export const revalidate = 0

async function handleGet(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    await requireAuth()
    const { jobId } = await params
    const job = await getImportJob(jobId)
    if (!job) {
      return Response.json({ error: 'Job not found' }, { status: 404 })
    }

    const completed = job.status === 'completed'
    const persistedOutcomeRows = job.importedCount + job.updatedCount + job.skippedCount + job.failedCount
    const snapshot = completed
      ? { ...(job.progressSnapshot ?? {}), processedRecords: persistedOutcomeRows, importedCount: job.importedCount, updatedCount: job.updatedCount, skippedCount: job.skippedCount, failedCount: job.failedCount, progressPercent: 100 }
      : (job.progressSnapshot ?? {})
    const processedRows = completed ? persistedOutcomeRows : Math.max(snapshot.processedRecords ?? 0, job.processedRows)
    const totalRows = Math.max(snapshot.estimatedTotalRecords ?? 0, job.totalRows)
    const startedAt = snapshot.startedAt ?? job.startedAt
    const elapsedMs = startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : (job.durationMs ?? 0)
    const remaining = job.status === 'completed' ? 0 : (totalRows > processedRows ? totalRows - processedRows : null)
    const secondsRemaining = remaining !== null && (snapshot.averageThroughput ?? 0) > 0 ? remaining / Number(snapshot.averageThroughput) : null
    const livePercent = totalRows ? Math.min(100, Math.round((processedRows / totalRows) * 10000) / 100) : 0
    const progressPercent = completed ? 100 : Math.max(Number(snapshot.progressPercent ?? 0), livePercent)
    logger.info('quickbooks.import_job.progress.read', {
      importJobId: job.id,
      companyId: job.companyId,
      status: job.status,
      processedRows,
      totalRows,
      activityEventCount: job.activityEvents?.length ?? 0,
      hasProgressSnapshot: Object.keys(snapshot).length > 0,
    })
    const responsePayload = {
      id: job.id,
      status: job.status,
      totalRows,
      processedRows,
      importedCount: snapshot.importedCount ?? job.importedCount,
      updatedCount: snapshot.updatedCount ?? job.updatedCount,
      skippedCount: snapshot.skippedCount ?? job.skippedCount,
      failedCount: snapshot.failedCount ?? job.failedCount,
      validRows: job.validRows,
      invalidRows: job.invalidRows,
      warningCount: job.warningCount,
      durationMs: job.durationMs,
      completedAt: job.completedAt,
      batchSize: job.batchSize,
      batchCursor: job.batchCursor,
      retryCount: job.retryCount,
      pausedAt: job.pausedAt,
      progressSnapshot: snapshot,
      activityEvents: job.activityEvents ?? [],
      skipSummary: job.skipSummary ?? {},
      currentModule: snapshot.currentModule ?? job.moduleKey,
      currentStage: snapshot.currentStage ?? null,
      currentRecord: snapshot.currentRecord ?? null,
      progressPercent,
      currentBatch: snapshot.currentBatch ?? (Math.floor(processedRows / Math.max(1, job.batchSize ?? 250)) + 1),
      totalBatches: snapshot.totalBatches ?? (totalRows ? Math.ceil(totalRows / Math.max(1, job.batchSize ?? 250)) : null),
      estimatedRemaining: remaining,
      elapsedMs,
      throughput: snapshot.throughput ?? null,
      averageThroughput: snapshot.averageThroughput ?? null,
      estimatedRemainingSeconds: secondsRemaining,
      estimatedCompletionAt: secondsRemaining === null ? null : new Date(Date.now() + secondsRemaining * 1000).toISOString(),
    }
    logger.info('quickbooks.import_job.progress.response', { importJobId: job.id, companyId: job.companyId, responseJson: responsePayload })
    return Response.json(responsePayload, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
