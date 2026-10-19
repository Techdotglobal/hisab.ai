import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import {
  deleteMappingTemplate,
  updateMappingTemplate,
} from '@/lib/import-export/mapping/mapping-template.service'
import { apiError } from '@/lib/import-export/api-helpers'

async function handlePut(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params
    const body = await request.json()

    const template = await updateMappingTemplate(id, {
      name: typeof body.name === 'string' ? body.name.trim() : undefined,
      columnMapping: body.columnMapping,
      headerFingerprint: body.headerFingerprint,
      isDefault: body.isDefault,
    })

    return Response.json(template)
  } catch (error) {
    return apiError(error)
  }
}

async function handleDelete(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params
    await deleteMappingTemplate(id)
    return Response.json({ success: true })
  } catch (error) {
    return apiError(error)
  }
}

export const PUT = guarded('imports.run', handlePut)
export const DELETE = guarded('imports.run', handleDelete)
