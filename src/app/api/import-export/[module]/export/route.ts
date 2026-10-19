import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { resolveCompanyId } from '@/lib/tenant'
import {
  getExportHeaders,
  getExportLabels,
  serializeExport,
} from '@/lib/import-export/export/export-engine'
import { getModuleDefinition } from '@/lib/import-export/registry/module-registry'
import { FrameworkBadRequestError } from '@/lib/import-export/errors'
import { apiError } from '@/lib/import-export/api-helpers'
import { filtersFromSearchParams, resolveModuleParam } from '../../_lib/module-params'
import type { FileFormat } from '@/lib/import-export/types'
import { MAX_EXPORT_ROWS } from '@/lib/import-export/types'

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ module: string }> },
) {
  try {
    const user = await requireAuth()
    const { module: moduleKey } = await params
    resolveModuleParam(moduleKey)

    const { searchParams } = new URL(request.url)
    const format = (searchParams.get('format') ?? 'csv') as FileFormat
    if (format !== 'csv' && format !== 'xlsx') {
      return Response.json({ error: 'Invalid format' }, { status: 400 })
    }

    const definition = getModuleDefinition(moduleKey)
    const companyId = await resolveCompanyId()
    const filters = filtersFromSearchParams(searchParams)
    const records = await definition.exportRecords(filters, { companyId, userId: user.id })
    if (records.length > MAX_EXPORT_ROWS) {
      throw new FrameworkBadRequestError(
        `Export exceeds maximum of ${MAX_EXPORT_ROWS} rows. Apply filters to reduce the dataset.`,
      )
    }
    const headers = getExportHeaders(definition.fields)
    const labels = getExportLabels(definition.fields)
    const rows = records.map((record) => definition.mapExportRow(record))
    const payload = serializeExport(format, headers, rows, labels)

    return new Response(payload.content, {
      headers: {
        'Content-Type': payload.mimeType,
        'Content-Disposition': `attachment; filename="${moduleKey}-export.${payload.extension}"`,
      },
    })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
