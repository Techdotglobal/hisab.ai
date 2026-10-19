import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { parseCsv } from '@/lib/import-export/parsers/csv-parser'
import { parseExcel } from '@/lib/import-export/parsers/excel-parser'
import { detectFormatFromFilename } from '@/lib/import-export/parsers/detect-format'
import { autoMapColumns } from '@/lib/import-export/mapping/auto-mapper'
import { buildHeaderFingerprint } from '@/lib/import-export/mapping/normalize-header'
import { findTemplateByFingerprint } from '@/lib/import-export/mapping/mapping-template.service'
import {
  buildOfficialTemplateMapping,
  detectOfficialTemplate,
  isOfficialTemplateMappingComplete,
} from '@/lib/import-export/templates/official-template'
import { getModuleDefinition } from '@/lib/import-export/registry/module-registry'
import { apiError } from '@/lib/import-export/api-helpers'
import { MAX_IMPORT_ROWS, MAX_UPLOAD_BYTES } from '@/lib/import-export/types'
import { resolveModuleParam } from '../../_lib/module-params'

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ module: string }> },
) {
  try {
    await requireAuth()
    const { module: moduleKey } = await params
    resolveModuleParam(moduleKey)

    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return Response.json({ error: 'File is required' }, { status: 400 })
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: `File exceeds maximum size of ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB` },
        { status: 400 },
      )
    }

    const format = detectFormatFromFilename(file.name)
    if (!format) {
      return Response.json({ error: 'Unsupported file format. Use CSV or XLSX.' }, { status: 400 })
    }

    const buffer = await file.arrayBuffer()
    const parsed = format === 'csv'
      ? parseCsv(new TextDecoder().decode(buffer))
      : parseExcel(buffer)

    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      return Response.json(
        { error: `File exceeds maximum of ${MAX_IMPORT_ROWS} rows` },
        { status: 400 },
      )
    }

    const definition = getModuleDefinition(moduleKey)
    const fingerprint = buildHeaderFingerprint(parsed.headers)

    const officialTemplate = detectOfficialTemplate(parsed.headers, definition.officialTemplates)
    let suggestedMapping
    let skipMapping = false
    let templateId: string | null = null

    if (officialTemplate) {
      suggestedMapping = buildOfficialTemplateMapping(parsed.headers, officialTemplate)
      skipMapping = isOfficialTemplateMappingComplete(officialTemplate, suggestedMapping)
      templateId = officialTemplate.id
    } else {
      const savedTemplate = await findTemplateByFingerprint(moduleKey, fingerprint)
      suggestedMapping = savedTemplate?.columnMapping
        ? Object.fromEntries(
            parsed.headers.map((header) => [
              header,
              savedTemplate.columnMapping[header] ?? null,
            ]),
          )
        : autoMapColumns(parsed.headers, definition.fields)
      templateId = savedTemplate?.id ?? null
    }

    return Response.json({
      filename: file.name,
      format: parsed.format,
      headers: parsed.headers,
      rows: parsed.rows,
      suggestedMapping,
      headerFingerprint: fingerprint,
      templateId,
      officialTemplateId: officialTemplate?.id ?? null,
      officialTemplateName: officialTemplate?.name ?? null,
      skipMapping,
      previewRows: parsed.rows.slice(0, 20),
    })
  } catch (error) {
    return apiError(error)
  }
}

export const POST = guarded('imports.run', handlePost)
