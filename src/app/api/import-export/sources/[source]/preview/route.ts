import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getModuleDefinition } from '@/lib/import-export/registry/module-registry'
import { getImportSource, withSourcePreviewSession } from '@/lib/import-export/sources/source-registry'
import { getQuickBooksPreviewSupport } from '@/lib/import-export/sources/quickbooks.adapter'
import {
  generateIsolatedPreviews,
  PreviewProfiler,
  toPreviewError,
  type PreviewStage,
  type PreviewStageState,
} from '@/lib/import-export/sources/preview-service'
import { coerceMappedRows, validateMappedRows } from '@/lib/import-export/validation/validation-engine'
import type { MappedRow, ModuleDefinition } from '@/lib/import-export/types'
import { CORRELATION_HEADER, getCorrelationId } from '@/lib/ops/correlation'
import { withExternalRequestDiagnostics } from '@/lib/ops/external-request-diagnostics'
import { logger } from '@/lib/ops/logger'

const PREVIEW_SAMPLE_SIZE = 10
const PREVIEW_CONCURRENCY = 3

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ source: string }> },
) {
  const correlationId = getCorrelationId(request)
  const profiler = new PreviewProfiler(PREVIEW_CONCURRENCY, PREVIEW_SAMPLE_SIZE)
  let currentStage: PreviewStage = 'request_received'
  let sourceKey = 'unknown'
  const trace = (stage: PreviewStage, state: PreviewStageState, module: string | null = null) => {
    currentStage = stage
    profiler.stage(stage, state, module)
    const context = { correlationId, route: 'POST /api/import-export/sources/[source]/preview', stage, state, module, source: sourceKey }
    if (state === 'failed') logger.error('quickbooks.preview.stage', context)
    else logger.info('quickbooks.preview.stage', context)
  }

  return withExternalRequestDiagnostics({ onRequest: profiler.request }, async () => {
    trace('request_received', 'started')
    trace('request_received', 'completed')
    try {
    trace('authentication', 'started')
    const user = await requireAuth()
    trace('authentication', 'completed')
    trace('company_resolution', 'started')
    const tenantId = user.companyId
    if (!tenantId) throw new Error('No active company is available for this user.')
    trace('company_resolution', 'completed')
    sourceKey = (await params).source
    trace('adapter_initialization', 'started')
    const source = getImportSource(sourceKey)
    trace('adapter_initialization', 'completed')
    const body = await request.json() as { resources?: unknown }
    const requested = Array.isArray(body.resources)
      ? [...new Set(body.resources.filter((item): item is string => typeof item === 'string'))]
      : []
    if (requested.length === 0 || requested.length > 100) {
      const error = toPreviewError(new Error('Select one or more valid import resources.'), 'request_received', null, 'INVALID_RESOURCE_SELECTION', correlationId)
      trace('request_received', 'failed')
      return Response.json(error, { status: 400, headers: { [CORRELATION_HEADER]: correlationId } })
    }

    const resources = await withSourcePreviewSession(
      tenantId,
      sourceKey,
      PREVIEW_SAMPLE_SIZE,
      { onStage: trace },
      (session) => generateIsolatedPreviews({
        requested,
        resources: session.source.resources,
        correlationId,
        concurrency: PREVIEW_CONCURRENCY,
        resolveModule: (moduleKey) => getModuleDefinition(moduleKey),
        isSupported: (resourceKey) => sourceKey === 'quickbooks' ? getQuickBooksPreviewSupport(resourceKey) : { supported: true },
        onStage: trace,
        generate: (resource, definition) => withExternalRequestDiagnostics(
          { onRequest: profiler.request, module: resource.key },
          async () => {
            const normalized = await session.fetchResource(resource.key)
            const moduleDefinition = definition as ModuleDefinition
            const mappedRows: MappedRow[] = normalized.rows.map((row, index) => ({
              rowNumber: index + 2,
              source: row,
              mapped: row,
            }))
            const coerced = coerceMappedRows(mappedRows, moduleDefinition.fields)
            const validation = validateMappedRows(coerced, moduleDefinition.fields)
            const headers = moduleDefinition.fields.filter((field) => field.importable !== false).map((field) => field.key)
            const count = normalized.totalCount ?? normalized.rows.length
            profiler.result(resource.key, normalized.rows.length, count)
            return {
              ...normalized,
              count,
              headers,
              mapping: Object.fromEntries(headers.map((header) => [header, header])),
              validation,
              duplicates: [],
              duplicateDetection: 'deferred' as const,
              sampleRows: normalized.rows,
            }
          },
        ),
      }),
    )

    trace('preview_response', 'started')
    trace('preview_response', 'completed')
    const diagnostics = profiler.report()
    logger.info('quickbooks.preview.profile', { correlationId, source: sourceKey, ...diagnostics })
    return Response.json({ source: { key: source.key, label: source.label }, resources, correlationId, diagnostics }, {
      headers: { [CORRELATION_HEADER]: correlationId },
    })
    } catch (error) {
      const structured = toPreviewError(error, currentStage, null, 'PREVIEW_REQUEST_FAILED', correlationId)
      trace(structured.stage, 'failed', structured.module)
      logger.error('quickbooks.preview.failed', {
        route: 'POST /api/import-export/sources/[source]/preview',
        ...structured,
        diagnostics: profiler.report(),
        errorName: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      })
      const status = structured.stage === 'authentication' ? 401
        : structured.stage === 'request_received' ? 400
          : structured.stage === 'company_resolution' ? 403
            : 500
      return Response.json(structured, { status, headers: { [CORRELATION_HEADER]: correlationId } })
    }
  })
}

export const POST = guarded('imports.run', handlePost)
