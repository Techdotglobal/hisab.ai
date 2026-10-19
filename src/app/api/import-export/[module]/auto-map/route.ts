import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { autoMapColumns } from '@/lib/import-export/mapping/auto-mapper'
import { getModuleDefinition } from '@/lib/import-export/registry/module-registry'
import { apiError } from '@/lib/import-export/api-helpers'
import { resolveModuleParam } from '../../_lib/module-params'

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ module: string }> },
) {
  try {
    await requireAuth()
    const { module: moduleKey } = await params
    resolveModuleParam(moduleKey)

    const body = await request.json()
    const headers = Array.isArray(body.headers) ? body.headers.map(String) : []
    if (headers.length === 0) {
      return Response.json({ error: 'Headers are required' }, { status: 400 })
    }

    const definition = getModuleDefinition(moduleKey)
    const mapping = autoMapColumns(headers, definition.fields)

    return Response.json({ mapping })
  } catch (error) {
    return apiError(error)
  }
}

export const POST = guarded('imports.run', handlePost)
