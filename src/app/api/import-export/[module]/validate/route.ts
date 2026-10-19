import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { resolveCompanyId } from '@/lib/tenant'
import { detectDuplicates } from '@/lib/import-export/duplicate/duplicate-detector'
import { getModuleDefinition } from '@/lib/import-export/registry/module-registry'
import { apiError } from '@/lib/import-export/api-helpers'
import { resolveModuleParam } from '../../_lib/module-params'
import { buildMappedImportPayload } from '../../_lib/parse-import-body'

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ module: string }> },
) {
  try {
    const user = await requireAuth()
    const { module: moduleKey } = await params
    resolveModuleParam(moduleKey)

    const body = await request.json()
    const definition = getModuleDefinition(moduleKey)
    const { mappedRows, validation } = buildMappedImportPayload(definition, body)

    const companyId = await resolveCompanyId()
    const validRows = mappedRows.filter((row) => validation.validRowNumbers.includes(row.rowNumber))
    const duplicates = await detectDuplicates(definition, validRows, { companyId, userId: user.id })

    const issuesWithDuplicates = [...validation.issues]
    for (const duplicate of duplicates) {
      issuesWithDuplicates.push({
        rowNumber: duplicate.rowNumber,
        code: 'DUPLICATE_RECORD',
        message: `Matches existing record (${duplicate.matchedOn.join(', ')})`,
        severity: 'warning',
      })
    }

    const warningCount = issuesWithDuplicates.filter((issue) => issue.severity === 'warning').length

    return Response.json({
      validation: {
        ...validation,
        issues: issuesWithDuplicates,
        warningCount,
      },
      duplicates,
      previewRows: mappedRows.slice(0, 20),
    })
  } catch (error) {
    return apiError(error)
  }
}

export const POST = guarded('imports.run', handlePost)
