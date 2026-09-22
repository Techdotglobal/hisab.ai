import { resolveCompanyId } from '@/lib/tenant'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { detectDuplicates } from '@/lib/import-export/duplicate/duplicate-detector'
import { getModuleDefinition } from '@/lib/import-export/registry/module-registry'
import {
  createImportJob,
  finalizeImportJob,
  getImportJob,
  isJobCancelled,
  isJobPaused,
  setImportJobStatus,
  saveImportJobErrors,
  updateImportJobProgress,
  saveImportJobSkips,
} from '@/lib/import-export/jobs/import-job.service'
import { mappingSnapshot } from '@/lib/import-export/mapping/auto-mapper'
import { processImport } from '@/lib/import-export/import/import-processor'
import { apiError } from '@/lib/import-export/api-helpers'
import { resolveModuleParam } from '../../_lib/module-params'
import {
  buildMappedImportPayload,
  parseFileFormatFromBody,
  parseFilenameFromBody,
} from '../../_lib/parse-import-body'
import type { DuplicateStrategy } from '@/lib/import-export/types'
import { normalizeImportError } from '@/lib/import-export/import/import-error'
import {
  buildModuleFailureFromException,
  buildFinalJobFailure,
  computeImportJobStatus,
} from '@/lib/import-export/wizard/migration-failure'
import { CORRELATION_HEADER, getCorrelationId } from '@/lib/ops/correlation'
import { withExternalRequestDiagnostics } from '@/lib/ops/external-request-diagnostics'
import { MigrationTrace, type MigrationTraceSnapshot } from '@/lib/import-export/quickbooks/migration-telemetry'
import { fetchSourceResourcePage, getImportSource } from '@/lib/import-export/sources/source-registry'
import { FrameworkBadRequestError } from '@/lib/import-export/errors'
import { enqueueJob } from '@/lib/platform/jobs/queue'
import { withCompanyContext } from '@/lib/tenant'
import { isOwnershipLostError, type JobOwnership } from '@/lib/platform/jobs/ownership'
import { logger } from '@/lib/ops/logger'
import type { MigrationActivityEvent, MigrationProgressSnapshot, SkippedRecordDiagnostic } from '@/lib/import-export/types'
import { isImportJobMigrationCancelled } from '@/lib/import-export/wizard/migration-session.service'
import { createProgressWriteQueue } from '@/lib/import-export/jobs/progress-write-queue'

async function enqueueQuickBooksContinuationOnce(input: {
  companyId: string
  importJobId: string
  moduleKey: string
  userId: string
}): Promise<{ created?: Record<string, unknown>; existing?: { id: string; status: string; attempts: number | null } }> {
  const client = await import('@/lib/supabase/admin')
  try {
    const job = await enqueueJob({
      jobType: 'QUICKBOOKS_IMPORT_STEP',
      companyId: input.companyId,
      payload: {
        importJobId: input.importJobId,
        moduleKey: input.moduleKey,
        companyId: input.companyId,
        userId: input.userId,
      },
    })
    return { created: job }
  } catch (error) {
    // Unique constraint on active continuations prevents duplicates. Treat
    // a 23505 as a race — return the existing active queue row for visibility.
    if ((error as { code?: string })?.code !== '23505') throw error
    const admin = (await client).createAdminClient()
    const { data, error: fetchErr } = await admin
      .from('job_queue')
      .select('id,status,attempts')
      .eq("job_type", 'QUICKBOOKS_IMPORT_STEP')
      .eq("company_id", input.companyId)
      .filter("payload->>importJobId", 'eq', input.importJobId)
      .in('status', ['PENDING','RUNNING'])
      .order('updated_at', { ascending: false })
      .limit(1)
    if (fetchErr) throw fetchErr
    const existing = data && data.length ? data[0] as any : null
    logger.info('quickbooks.import_job.continuation_already_queued', {
      importJobId: input.importJobId,
      companyId: input.companyId,
      existingPlatformJobId: existing?.id ?? null,
      existingStatus: existing?.status ?? null,
      existingAttempts: existing?.attempts ?? null,
    })
    return existing ? { existing: { id: String(existing.id), status: String(existing.status), attempts: existing.attempts ?? null } } : {}
  }
}

async function handleImport(
  request: Request,
  { params }: { params: Promise<{ module: string }> },
  trace: MigrationTrace,
  backgroundUser?: { id: string },
  ownership?: JobOwnership,
) {
  let jobId: string | null = null
  let sourcePage: Awaited<ReturnType<typeof fetchSourceResourcePage>> | null = null
  let resolvedCompanyId: string | undefined
  const ensureOwned = async () => {
    if (!ownership) return
    await ownership.assertOwned()
  }

  try {
    await ensureOwned()
    const { user, moduleKey } = await trace.measure('module_scheduling', async () => {
      const authenticated = backgroundUser ?? await requireAccountingAdmin()
      const { module: resolvedModule } = await params
      resolveModuleParam(resolvedModule)
      return { user: authenticated, moduleKey: resolvedModule }
    })

    const body = await request.json() as Record<string, unknown>
    const definition = getModuleDefinition(moduleKey)
    const filename = parseFilenameFromBody(body)
    const fileFormat = parseFileFormatFromBody(body)
    const duplicateStrategy = (['skip', 'update', 'create'].includes(String((body as Record<string, unknown>).duplicateStrategy))
      ? (body as Record<string, unknown>).duplicateStrategy
      : 'skip') as DuplicateStrategy

    const companyId = await resolveCompanyId()
    resolvedCompanyId = companyId
    const existingJobId = typeof body.jobId === 'string' ? body.jobId : null
    const existingJob = existingJobId ? await getImportJob(existingJobId, companyId) : null
    if (existingJobId && !existingJob) return Response.json({ error: 'Import job not found.' }, { status: 404 })
    if (existingJob && ['completed', 'failed', 'cancelled'].includes(existingJob.status)) {
      return Response.json({
        jobId: existingJob.id,
        status: existingJob.status,
        importedCount: existingJob.importedCount,
        updatedCount: existingJob.updatedCount,
        skippedCount: existingJob.skippedCount,
        failedCount: existingJob.failedCount,
        totalRows: existingJob.totalRows,
        processedRows: existingJob.processedRows,
      })
    }
    const sourceKey = typeof body.sourceKey === 'string' ? body.sourceKey : ''
    const resourceKey = typeof body.resourceKey === 'string' ? body.resourceKey : ''
    const sourceResource = sourceKey && resourceKey
      ? getImportSource(sourceKey).resources.find((resource) => resource.key === resourceKey)
      : undefined
    if ((sourceKey || resourceKey) && (!sourceResource || sourceResource.moduleKey !== moduleKey)) {
      throw new FrameworkBadRequestError('The selected source resource does not match the import module.')
    }

    // Source-backed background jobs deliberately persist only source identity
    // and user choices. Preview rows and mappings are never job input.
    if (body.background === true && !existingJobId && sourceResource) {
      const queued = await createImportJob({
        userId: user.id,
        moduleKey,
        filename,
        fileFormat,
        duplicateStrategy,
        totalRows: 0,
        mappingSnapshot: {},
        payloadSnapshot: { sourceKey, resourceKey, filename, fileFormat, duplicateStrategy },
        companyId,
      })
      jobId = queued.id
      await setImportJobStatus(queued.id, 'pending', companyId)
      trace.finish({ fetched: 0 })
      return Response.json({ jobId: queued.id, status: 'pending', totalRows: 0, batchSize: queued.batchSize ?? 250 }, { status: 202 })
    }

    let importBody = body
    if (existingJob && sourceResource) {
      // Snapshot-backed migration: read one raw page from the immutable Supabase
      // Storage snapshot instead of calling QuickBooks. Same SourceResourcePage
      // contract, so nothing else in this route changes.
      const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId : null
      sourcePage = snapshotId
        ? await trace.measure('extraction', async () => {
            const { fetchSnapshotResourcePage } = await import('@/lib/import-export/quickbooks/snapshot/snapshot-source')
            return fetchSnapshotResourcePage({ companyId, snapshotId, resourceKey, importJobId: existingJob.id })
          })
        : await trace.measure('extraction', () => fetchSourceResourcePage(companyId, sourceKey, resourceKey))
      const normalized = sourcePage.resource
      const fullMapping = Object.fromEntries(definition.fields
        .filter((field) => field.importable !== false)
        .map((field) => [field.key, field.key]))
      importBody = { ...body, rows: normalized.rows, mapping: fullMapping }
    }
    const { mappedRows, validation, mapping } = await trace.measure('validation', () => buildMappedImportPayload(definition, importBody))
    const job = existingJob ?? await createImportJob({
      userId: user.id, moduleKey, filename, fileFormat, duplicateStrategy,
      mappingSnapshot: mappingSnapshot(mapping), totalRows: mappedRows.length,
      payloadSnapshot: { rows: mappedRows, validation, mapping, filename, fileFormat, duplicateStrategy },
      companyId,
    })
    jobId = job.id

    const validationErrors = validation.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => ({
        rowNumber: issue.rowNumber,
        fieldKey: issue.fieldKey,
        errorCode: issue.code,
        message: issue.message,
      }))

    const validRows = mappedRows.filter((row) => validation.validRowNumbers.includes(row.rowNumber))
    const validationSkips: SkippedRecordDiagnostic[] = mappedRows
      .filter((row) => !validation.validRowNumbers.includes(row.rowNumber))
      .map((row) => {
        const mapped = row.mapped as Record<string, unknown>
        const sourceId = [mapped._quickbooksId, mapped.Id, mapped.id, mapped.docNumber, mapped.accountNo, mapped.sku].find((value) => value !== undefined && value !== null && String(value).trim() !== '')
        const recordName = [mapped.name, mapped.displayName, mapped.customerName, mapped.vendorName, mapped.docNumber].find((value) => value !== undefined && value !== null && String(value).trim() !== '')
        return { rowNumber: row.rowNumber, sourceId: sourceId === undefined ? undefined : String(sourceId), recordName: recordName === undefined ? undefined : String(recordName), reason: 'validation_failed' as const }
      })
    // Client/preview duplicate results are advisory only. Import always checks
    // the authoritative tenant data immediately before applying a strategy.
    const duplicateMatches = await trace.measure('duplicate_detection', () => detectDuplicates(definition, validRows, { companyId, userId: user.id, performance: trace }))

    if (body.background === true && !existingJobId) {
      await setImportJobStatus(job.id, 'pending', companyId)
      trace.finish({ fetched:mappedRows.length })
      return Response.json({ jobId: job.id, status: 'pending', totalRows: mappedRows.length, batchSize: job.batchSize ?? 250 }, { status: 202 })
    }

    const base = existingJob ? { importedCount: existingJob.importedCount, updatedCount: existingJob.updatedCount, skippedCount: existingJob.skippedCount, failedCount: existingJob.failedCount } : { importedCount: 0, updatedCount: 0, skippedCount: 0, failedCount: 0 }
    const baseProcessedRows = existingJob?.processedRows ?? 0
    if (existingJob) {
      trace.setTotals(existingJob.processedRows, existingJob.totalRows)
      trace.setCounts({
        importedCount: existingJob.importedCount,
        updatedCount: existingJob.updatedCount,
        skippedCount: existingJob.skippedCount,
        failedCount: existingJob.failedCount,
      })
    }
    const result = await trace.measure('materialization', () => processImport({
      module:definition,
      rows: mappedRows,
      validation,
      duplicateStrategy,
      duplicateMatches,
      ctx: { companyId, userId: user.id, performance: trace },
      onProgress: async (processed, _total, counts) => {
        await ensureOwned()
        const absoluteProcessed = sourcePage ? baseProcessedRows + processed : processed
        if (counts) {
          trace?.setCounts({
            importedCount: base.importedCount + counts.importedCount,
            updatedCount: base.updatedCount + counts.updatedCount,
            skippedCount: base.skippedCount + counts.skippedCount,
            failedCount: base.failedCount + counts.failedCount,
          })
        }
        trace?.batch(Math.min(job.batchSize ?? 250, Math.max(0, absoluteProcessed - baseProcessedRows)), absoluteProcessed, Math.max(_total, sourcePage?.checkpoint.fetched ?? _total, job.totalRows))
        trace?.setTotals(absoluteProcessed, Math.max(_total, sourcePage?.checkpoint.fetched ?? 0, job.totalRows))
        await updateImportJobProgress(job.id, absoluteProcessed, counts?{
          importedCount:base.importedCount+counts.importedCount,
          updatedCount:base.updatedCount+counts.updatedCount,
          skippedCount:base.skippedCount+counts.skippedCount,
          failedCount:base.failedCount+counts.failedCount,
        }:undefined, Math.max(sourcePage?.checkpoint.fetched ?? 0, job.totalRows, absoluteProcessed), {
          progressSnapshot: trace?.snapshot() as MigrationProgressSnapshot,
        }, companyId)
      },
      isCancelled: () => isJobCancelled(job.id, companyId),
      isPaused: () => isJobPaused(job.id, companyId),
      assertActive: ensureOwned,
      startAt: sourcePage ? 0 : job.batchCursor ?? 0,
      batchSize: sourcePage ? 100 : job.batchSize ?? 250,
      maxBatches: sourcePage ? 1 : undefined,
      trace,
    }))

    // Post-materialization orchestration is where a stalled module leaves the
    // queue row RUNNING forever, so each step is traceable on its own.
    const orchestrationStep = (step: string, meta?: Record<string, unknown>) => {
      logger.info('quickbooks.import_job.orchestration.step', {
        importJobId: job.id,
        module: moduleKey,
        platformJobId: ownership?.platformJobId,
        attempt: ownership?.attempt,
        step,
        ...meta,
      })
    }

    const allErrors = [...validationErrors, ...result.errors]
    const skippedRecords = [...validationSkips, ...result.skippedRecords]
    orchestrationStep('save_skips', { skippedRecords: skippedRecords.length })
    await saveImportJobSkips(job.id, skippedRecords, companyId)
    const skipSummary = skippedRecords.reduce<Record<string, number>>((summary, item) => {
      const label = item.reason === 'duplicate' ? 'Duplicate (already exists)' : item.reason === 'validation_failed' ? 'Validation failed' : item.reason === 'inactive' ? 'Inactive records' : item.reason === 'filtered' ? 'Filtered by module' : item.reason === 'unsupported_type' ? 'Unsupported type' : 'Other'
      summary[label] = (summary[label] ?? 0) + 1
      return summary
    }, { 'Duplicate (already exists)': 0, 'Inactive records': 0, 'Filtered by module': 0, 'Validation failed': 0, 'Unsupported type': 0, Other: 0 })
    orchestrationStep('save_errors', { errors: allErrors.length })
    await saveImportJobErrors(job.id, allErrors, companyId)
    const aggregate = { importedCount: base.importedCount + result.importedCount, updatedCount: base.updatedCount + result.updatedCount, skippedCount: base.skippedCount + result.skippedCount, failedCount: base.failedCount + result.failedCount }
    const invalidRowCount = validation.invalidRowNumbers.length
    const aggregateSkippedCount = aggregate.skippedCount + invalidRowCount
    orchestrationStep('cancel_checks')
    const cancelledAfterBatch = await isJobCancelled(job.id, companyId)
    // Session cancel never interrupts the batch above; stop before the next continuation.
    const sessionCancelled = await isImportJobMigrationCancelled(job.id, companyId)
    orchestrationStep('cancel_checks_resolved', {
      paused: result.paused,
      cancelledAfterBatch,
      sessionCancelled,
      hasMore: sourcePage?.hasMore ?? false,
    })

    if (result.paused || cancelledAfterBatch || sessionCancelled) {
      await ensureOwned()
      if (sessionCancelled && !cancelledAfterBatch && !result.paused) {
        // The active batch is complete at this point. Persist its source
        // checkpoint before making the import job terminal so resume starts
        // from the next page instead of replaying the completed batch.
        if (sourcePage) {
          await sourcePage.commit()
          await updateImportJobProgress(job.id, sourcePage.checkpoint.fetched, {
            ...aggregate,
            skippedCount: aggregateSkippedCount,
            validRows: (job.validRows ?? 0) + validation.validRowNumbers.length,
            invalidRows: (job.invalidRows ?? 0) + invalidRowCount,
            warningCount: (job.warningCount ?? 0) + validation.warningCount,
          }, sourcePage.checkpoint.fetched, undefined, companyId)
        }
        await finalizeImportJob(job.id, {
          status: 'cancelled',
          importedCount: aggregate.importedCount,
          updatedCount: aggregate.updatedCount,
          skippedCount: aggregateSkippedCount,
          failedCount: aggregate.failedCount,
          totalRows: sourcePage?.checkpoint.fetched ?? mappedRows.length,
          validRows: (job.validRows ?? 0) + validation.validRowNumbers.length,
          invalidRows: (job.invalidRows ?? 0) + invalidRowCount,
          warningCount: (job.warningCount ?? 0) + validation.warningCount,
          startedAt: job.startedAt,
        }, companyId)
      } else {
        await setImportJobStatus(job.id, result.paused ? 'paused' : 'pending', companyId)
      }
      trace.finish({ fetched: sourcePage?.checkpoint.fetched ?? mappedRows.length, imported: aggregate.importedCount, updated: aggregate.updatedCount, skipped: aggregate.skippedCount, failed: aggregate.failedCount })
      return Response.json({ jobId: job.id, status: result.paused ? 'paused' : 'cancelled', ...aggregate, totalRows: sourcePage?.checkpoint.fetched ?? mappedRows.length, validRows: validation.validRowNumbers.length, invalidRows: validation.invalidRowNumbers.length, warningCount: validation.warningCount, durationMs: Date.now() - new Date(job.startedAt ?? Date.now()).getTime() })
    }

    if (sourcePage?.hasMore) {
      await ensureOwned()
      orchestrationStep('commit_checkpoint', { fetched: sourcePage.checkpoint.fetched })
      await sourcePage.commit()
      // When the source indicates hasMore=true, avoid persisting total_rows equal
      // to processed_rows (which would make the job appear terminal). Instead
      // persist a conservative total > processed to indicate more pages remain.
      const persistedTotal = Math.max(job.totalRows ?? 0, sourcePage.checkpoint.fetched + (sourcePage.hasMore ? 1 : 0))
      await updateImportJobProgress(job.id, sourcePage.checkpoint.fetched, { ...aggregate, skippedCount: aggregateSkippedCount, validRows: (job.validRows ?? 0) + validation.validRowNumbers.length, invalidRows: (job.invalidRows ?? 0) + invalidRowCount, warningCount: (job.warningCount ?? 0) + validation.warningCount }, persistedTotal, undefined, companyId)
      await ensureOwned()
      if (await isImportJobMigrationCancelled(job.id, companyId)) {
        await finalizeImportJob(job.id, {
          status: 'cancelled',
          importedCount: aggregate.importedCount,
          updatedCount: aggregate.updatedCount,
          skippedCount: aggregateSkippedCount,
          failedCount: aggregate.failedCount,
          totalRows: sourcePage.checkpoint.fetched,
          validRows: (job.validRows ?? 0) + validation.validRowNumbers.length,
          invalidRows: (job.invalidRows ?? 0) + invalidRowCount,
          warningCount: (job.warningCount ?? 0) + validation.warningCount,
          startedAt: job.startedAt,
        }, companyId)
        trace.finish({ fetched: sourcePage.checkpoint.fetched, imported: aggregate.importedCount, updated: aggregate.updatedCount, skipped: aggregate.skippedCount, failed: aggregate.failedCount })
        return Response.json({
          jobId: job.id,
          status: 'cancelled',
          ...aggregate,
          skippedCount: aggregateSkippedCount,
          totalRows: sourcePage.checkpoint.fetched,
          validRows: validation.validRowNumbers.length,
          invalidRows: validation.invalidRowNumbers.length,
          warningCount: validation.warningCount,
          durationMs: Date.now() - new Date(job.startedAt ?? Date.now()).getTime(),
        })
      }
      orchestrationStep('enqueue_continuation')
      const enqueueResult = await enqueueQuickBooksContinuationOnce({ companyId, importJobId: job.id, moduleKey, userId: user.id })
      if (enqueueResult?.created) {
        orchestrationStep('continuation_enqueued', { continuationPlatformJobId: enqueueResult.created.id })
      } else if (enqueueResult?.existing) {
        // Already active: log the existing platform job details instead of
        // claiming success for a new durable enqueue.
        orchestrationStep('continuation_already_active', {
          existingPlatformJobId: enqueueResult.existing.id,
          existingStatus: enqueueResult.existing.status,
          existingAttempts: enqueueResult.existing.attempts,
        })
      } else {
        // Defensive fallback: no created row and no visible existing row.
        orchestrationStep('continuation_enqueue_unknown')
      }
      trace.finish({ fetched: sourcePage.checkpoint.fetched, imported: aggregate.importedCount, updated: aggregate.updatedCount, skipped: aggregate.skippedCount, failed: aggregate.failedCount })
      return Response.json({
        jobId: job.id,
        status: 'processing',
        ...aggregate,
        skippedCount: aggregateSkippedCount,
        totalRows: sourcePage.checkpoint.fetched,
        validRows: validation.validRowNumbers.length,
        invalidRows: validation.invalidRowNumbers.length,
        warningCount: validation.warningCount,
        durationMs: Date.now() - new Date(job.startedAt ?? Date.now()).getTime(),
      })
    }

    if (sourcePage) await sourcePage.commit()

    const status = computeImportJobStatus({
      importedCount: aggregate.importedCount,
      updatedCount: aggregate.updatedCount,
      failedCount: aggregate.failedCount,
      skippedRecords,
    })
    const rowFailure = status === 'failed'
      ? buildFinalJobFailure(allErrors, skippedRecords, { stage: trace.snapshot().currentStage ?? 'materialization' })
      : null

    await ensureOwned()
    orchestrationStep('finalize', { status })
    const finalized = await trace.measure('report_generation', () => finalizeImportJob(job.id, {
      status,
      importedCount: aggregate.importedCount,
      updatedCount: aggregate.updatedCount,
      skippedCount: aggregateSkippedCount,
      failedCount: aggregate.failedCount,
      totalRows: sourcePage?.checkpoint.fetched ?? mappedRows.length,
      validRows: (existingJob?.validRows ?? 0) + validation.validRowNumbers.length,
      invalidRows: (existingJob?.invalidRows ?? 0) + invalidRowCount,
      warningCount: validation.warningCount,
      validationSummary: validation.summaryByCode,
      errorSummary: allErrors.reduce<Record<string, number>>((acc, item) => {
        acc[item.errorCode] = (acc[item.errorCode] ?? 0) + 1
        return acc
      }, {}),
      skipSummary,
      startedAt: job.startedAt,
      failure: rowFailure,
    }, companyId))

    orchestrationStep('finalized', { status: finalized.status })
    trace.finish({ fetched:mappedRows.length, imported:finalized.importedCount, updated:finalized.updatedCount, skipped:finalized.skippedCount, failed:finalized.failedCount })
    return Response.json({
      jobId: finalized.id,
      status: finalized.status,
      importedCount: finalized.importedCount,
      updatedCount: finalized.updatedCount,
      skippedCount: finalized.skippedCount,
      failedCount: finalized.failedCount,
      totalRows: finalized.totalRows,
      validRows: finalized.validRows,
      invalidRows: finalized.invalidRows,
      warningCount: finalized.warningCount,
      durationMs: finalized.durationMs,
      errors: allErrors,
    })
  } catch (error) {
    if (isOwnershipLostError(error)) {
      logger.warn('quickbooks.import_job.abandoned_after_ownership_loss', {
        importJobId: jobId,
        platformJobId: ownership?.platformJobId,
        attempt: ownership?.attempt,
        error: { message: error.message, name: error.name },
      })
      trace.finish()
      throw error
    }
    const normalized=normalizeImportError(error)
    if (jobId) {
      try {
        if (ownership) await ownership.assertOwned()
        const existing = await getImportJob(jobId, resolvedCompanyId)
        const failure = buildModuleFailureFromException(error, {
          stage: normalized.details.stage
            ?? existing?.progressSnapshot?.currentStage
            ?? null,
          correlationId: trace.correlationId,
          includeStack: process.env.NODE_ENV !== 'production',
        })
        await finalizeImportJob(jobId, {
          status: 'failed',
          importedCount: existing?.importedCount ?? 0,
          updatedCount: existing?.updatedCount ?? 0,
          skippedCount: existing?.skippedCount ?? 0,
          failedCount: existing?.failedCount ?? 0,
          totalRows: existing?.totalRows ?? 0,
          startedAt: existing?.startedAt,
          failure,
          errorSummary: { [failure.errorCode ?? 'IMPORT_FATAL']: 1 },
        }, resolvedCompanyId)
        await saveImportJobErrors(jobId, [{
          rowNumber: 0,
          errorCode: failure.errorCode ?? 'IMPORT_FATAL',
          message: failure.message,
          details: {
            ...normalized.details,
            stage: failure.stage ?? undefined,
            code: failure.errorCode ?? undefined,
          },
          rawRow: {
            _importError: normalized.details,
            _failure: failure,
          },
        }], resolvedCompanyId)
      } catch (finalizeError) {
        if (isOwnershipLostError(finalizeError)) {
          logger.warn('quickbooks.import_job.failed_finalize_skipped_after_ownership_loss', {
            importJobId: jobId,
            platformJobId: ownership?.platformJobId,
            attempt: ownership?.attempt,
          })
        }
        // Best-effort job finalization.
      }
    }
    trace.finish()
    const response=apiError(error)
    if([401,403,404].includes(response.status))return response
    const status=normalized.details.status==='missing_dependency'?409:500
    return Response.json({ error:normalized.message, errorCode:normalized.errorCode, details:normalized.details },{status})
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ module: string }> },
) {
  const resolved = await params
  const trace = new MigrationTrace(resolved.module, getCorrelationId(request))
  const response = await withExternalRequestDiagnostics(
    { correlationId:trace.correlationId, module:resolved.module, onRequest:trace.request },
    () => handleImport(request, { params:Promise.resolve(resolved) }, trace),
  )
  response.headers.set(CORRELATION_HEADER, trace.correlationId)
  return response
}

/** Executes one bounded migration unit from the durable platform queue. */
export async function runImportJobStep(jobId: string, companyId: string, userId: string, ownership?: JobOwnership) {
  return withCompanyContext(companyId, async () => {
    if (ownership) await ownership.assertOwned()
    const job = await getImportJob(jobId, companyId)
    if (!job) return Response.json({ error: 'Import job not found.' }, { status: 404 })
    if (job.companyId !== companyId) {
      throw new Error(`Import job tenant mismatch: job ${job.id} belongs to ${job.companyId}, worker supplied ${companyId}.`)
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      logger.info('quickbooks.import_job.terminal_replay_skipped', {
        importJobId: job.id,
        companyId,
        status: job.status,
        processedRows: job.processedRows,
        totalRows: job.totalRows,
      })
      return Response.json({
        jobId: job.id,
        status: job.status,
        importedCount: job.importedCount,
        updatedCount: job.updatedCount,
        skippedCount: job.skippedCount,
        failedCount: job.failedCount,
        totalRows: job.totalRows,
        processedRows: job.processedRows,
      })
    }
    // Already-queued continuations must not start a new batch after session cancel.
    if (await isImportJobMigrationCancelled(job.id, companyId)) {
      await finalizeImportJob(job.id, {
        status: 'cancelled',
        importedCount: job.importedCount,
        updatedCount: job.updatedCount,
        skippedCount: job.skippedCount,
        failedCount: job.failedCount,
        totalRows: job.totalRows,
        validRows: job.validRows ?? undefined,
        invalidRows: job.invalidRows ?? undefined,
        warningCount: job.warningCount ?? undefined,
        startedAt: job.startedAt,
      }, companyId)
      return Response.json({ jobId: job.id, status: 'cancelled' })
    }
    await setImportJobStatus(job.id, 'processing', companyId)
    const progressWrites = createProgressWriteQueue({
      importJobId: job.id,
      companyId,
      platformJobId: ownership?.platformJobId,
      attempt: ownership?.attempt,
    })
    // The old code did a read-then-write on import_jobs for every trace event,
    // including the `stage_started` markers that carry no counts and no duration.
    // Coalesce those: buffer them and flush at most once per
    // PROGRESS_STAGE_EVENT_THROTTLE_MS. Everything that actually matters is
    // flushed immediately — the first event of the step (UI shows "started"
    // promptly), `batch_completed` (progress moved), `stage_failed` (failure must
    // be visible at once for cancellation/observability), and every
    // `stage_completed` (so each stage's duration lands while the job is still
    // non-terminal, before finalizeImportJob can make it immutable). Buffered
    // events are never dropped mid-step — they ride along on the next flush, and
    // a final flush runs once handleImport returns, before the queue drains.
    const PROGRESS_EVENT_MILESTONES = new Set(['batch_completed', 'stage_failed', 'stage_completed'])
    const PROGRESS_STAGE_EVENT_THROTTLE_MS = 5000
    let pendingActivityEvents: MigrationActivityEvent[] = []
    let hasPersistedFirstEvent = false
    let lastProgressFlushAt = 0

    const flushProgress = (snapshot: MigrationTraceSnapshot) => {
      if (pendingActivityEvents.length === 0) return
      const eventsToFlush = pendingActivityEvents
      pendingActivityEvents = []
      lastProgressFlushAt = Date.now()
      progressWrites.enqueue(async () => {
        if (ownership?.isLost()) {
          logger.info('quickbooks.import_job.progress.stale_ignored', {
            importJobId: job.id,
            companyId,
            platformJobId: ownership.platformJobId,
            attempt: ownership.attempt,
            reason: 'ownership_lost',
          })
          return
        }
        try {
          if (ownership) await ownership.assertOwned()
        } catch (error) {
          if (isOwnershipLostError(error)) {
            logger.info('quickbooks.import_job.progress.stale_ignored', {
              importJobId: job.id,
              companyId,
              platformJobId: ownership?.platformJobId,
              attempt: ownership?.attempt,
              reason: 'ownership_lost',
            })
            return
          }
          throw error
        }
        const eventProcessedRows = Math.max(job.processedRows, snapshot.processedRecords ?? 0)
        await updateImportJobProgress(job.id, eventProcessedRows, {
          importedCount: Math.max(job.importedCount, snapshot.importedCount ?? 0),
          updatedCount: Math.max(job.updatedCount, snapshot.updatedCount ?? 0),
          skippedCount: Math.max(job.skippedCount, snapshot.skippedCount ?? 0),
          failedCount: Math.max(job.failedCount, snapshot.failedCount ?? 0),
        }, Math.max(job.totalRows, snapshot.estimatedTotalRecords ?? 0), {
          progressSnapshot: snapshot as MigrationProgressSnapshot,
          activityEvents: eventsToFlush,
        }, companyId)
      })
    }

    const trace = new MigrationTrace(job.moduleKey, undefined, {
      initialActiveProcessingMs: Number(job.progressSnapshot?.activeProcessingMs ?? 0),
      onEvent: (event, snapshot) => {
        pendingActivityEvents.push(event as MigrationActivityEvent)
        const isMilestone = !hasPersistedFirstEvent || PROGRESS_EVENT_MILESTONES.has(event.type)
        const throttleElapsed = Date.now() - lastProgressFlushAt >= PROGRESS_STAGE_EVENT_THROTTLE_MS
        if (isMilestone || throttleElapsed) {
          hasPersistedFirstEvent = true
          flushProgress(snapshot)
        }
      },
    })
    trace.setTotals(job.processedRows, job.totalRows)
    trace.setCounts({
      importedCount: job.importedCount,
      updatedCount: job.updatedCount,
      skippedCount: job.skippedCount,
      failedCount: job.failedCount,
    })
    const response = await withExternalRequestDiagnostics(
      { correlationId: trace.correlationId, module: job.moduleKey, onRequest: trace.request },
      () => handleImport(
        new Request('http://internal/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(job.payloadSnapshot ?? {}), jobId }),
        }),
        { params: Promise.resolve({ module: job.moduleKey }) },
        trace,
        { id: userId },
        ownership,
      ),
    )
    // Persist whatever stage events were coalesced since the last milestone so
    // the final activity timeline and snapshot are never missing the tail.
    flushProgress(trace.snapshot())
    await progressWrites.drain()
    if (ownership) await ownership.assertOwned()
    return response
  })
}
