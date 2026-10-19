import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import {
  createMappingTemplate,
  listMappingTemplates,
} from '@/lib/import-export/mapping/mapping-template.service'
import { isRegisteredModule } from '@/lib/import-export/registry/module-registry'
import { apiError } from '@/lib/import-export/api-helpers'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const moduleKey = searchParams.get('module')
    if (!moduleKey || !isRegisteredModule(moduleKey)) {
      return Response.json({ error: 'Valid module is required' }, { status: 400 })
    }

    const templates = await listMappingTemplates(moduleKey)
    return Response.json(templates)
  } catch (error) {
    return apiError(error)
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()
    const moduleKey = typeof body.moduleKey === 'string' ? body.moduleKey : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''

    if (!moduleKey || !isRegisteredModule(moduleKey)) {
      return Response.json({ error: 'Valid module is required' }, { status: 400 })
    }
    if (!name) {
      return Response.json({ error: 'Template name is required' }, { status: 400 })
    }
    if (!body.columnMapping || typeof body.columnMapping !== 'object') {
      return Response.json({ error: 'Column mapping is required' }, { status: 400 })
    }

    const template = await createMappingTemplate({
      moduleKey,
      name,
      columnMapping: body.columnMapping,
      headerFingerprint: body.headerFingerprint ?? null,
      isDefault: Boolean(body.isDefault),
      createdById: user.id,
    })

    return Response.json(template, { status: 201 })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
export const POST = guarded('imports.run', handlePost)
