import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import {
  deleteImportHistory,
  getImportHistoryDetail,
} from '@/lib/import-export/history/import-history.service'
import { apiError } from '@/lib/import-export/api-helpers'
import { FrameworkNotFoundError } from '@/lib/import-export/errors'

async function handleGet(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params
    const detail = await getImportHistoryDetail(id)
    if (!detail) {
      return Response.json({ error: 'Import history record not found' }, { status: 404 })
    }
    return Response.json(detail)
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
    const deleted = await deleteImportHistory(id)
    if (!deleted) {
      throw new FrameworkNotFoundError('Import history record not found')
    }
    return Response.json({ success: true })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
export const DELETE = guarded('imports.run', handleDelete)
