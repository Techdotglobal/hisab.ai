import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { resolveCompanyId } from '@/lib/tenant'
import { applyColumnMapping } from '@/lib/import-export/mapping/auto-mapper'
import { detectDuplicates } from '@/lib/import-export/duplicate/duplicate-detector'
import { coerceMappedRows } from '@/lib/import-export/validation/validation-engine'
import { getModuleDefinition } from '@/lib/import-export/registry/module-registry'
import { apiError } from '@/lib/import-export/api-helpers'
import { resolveModuleParam } from '../../_lib/module-params'

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ module: string }> },
) {
  try {
    const user = await requireAuth()
    const { module: moduleKey } = await params
    resolveModuleParam(moduleKey)

    const body = await request.json()
    const rows = Array.isArray(body.rows) ? body.rows : []
    const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : {}

    const definition = getModuleDefinition(moduleKey)
    const mappedRows = coerceMappedRows(
      applyColumnMapping(rows, mapping),
      definition.fields,
    )
    const companyId = await resolveCompanyId()
    const duplicates = await detectDuplicates(definition, mappedRows, { companyId, userId: user.id })

    return Response.json({ duplicates })
  } catch (error) {
    return apiError(error)
  }
}

export const POST = guarded('imports.run', handlePost)
