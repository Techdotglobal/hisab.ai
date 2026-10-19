import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import {
  buildTemplateRows,
  getExportHeaders,
  getExportLabels,
  serializeExport,
} from '@/lib/import-export/export/export-engine'
import { getModuleDefinition } from '@/lib/import-export/registry/module-registry'
import { apiError } from '@/lib/import-export/api-helpers'
import { getOfficialTemplateById } from '@/lib/import-export/templates/official-template'
import { serializeOfficialTemplate } from '@/lib/import-export/templates/template-builder'
import { resolveModuleParam } from '../../_lib/module-params'
import type { FileFormat } from '@/lib/import-export/types'

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ module: string }> },
) {
  try {
    await requireAuth()
    const { module: moduleKey } = await params
    resolveModuleParam(moduleKey)

    const { searchParams } = new URL(request.url)
    const format = (searchParams.get('format') ?? 'csv') as FileFormat
    if (format !== 'csv' && format !== 'xlsx') {
      return Response.json({ error: 'Invalid format' }, { status: 400 })
    }

    const definition = getModuleDefinition(moduleKey)
    const templateId = searchParams.get('templateId')
    const official = getOfficialTemplateById(definition.officialTemplates, templateId)

    if (official) {
      const payload = serializeOfficialTemplate(format, official)
      return new Response(payload.content, {
        headers: {
          'Content-Type': payload.mimeType,
          'Content-Disposition': `attachment; filename="${moduleKey}-${official.id}-template.${payload.extension}"`,
        },
      })
    }

    const headers = getExportHeaders(definition.fields)
    const labels = getExportLabels(definition.fields)
    const rows = buildTemplateRows(definition.fields)
    const payload = serializeExport(format, headers, rows, labels)

    return new Response(payload.content, {
      headers: {
        'Content-Type': payload.mimeType,
        'Content-Disposition': `attachment; filename="${moduleKey}-template.${payload.extension}"`,
      },
    })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
