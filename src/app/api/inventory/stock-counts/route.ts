import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import {
  createStockCountSession,
  updateStockCountLine,
  postStockCountSession,
} from '@/lib/inventory/stock-count'
import { InventoryError } from '@/lib/inventory/movements'
import { listCompanyRows } from '@/lib/api/crud'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const warehouseId = searchParams.get('warehouseId')
    const rows = await listCompanyRows('stock_count_sessions', {
      orderBy: 'count_date',
      filters: warehouseId ? { warehouse_id: warehouseId } : undefined,
    })
    return Response.json(rows)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()

    if (body.action === 'update_line' && body.lineId) {
      const line = await updateStockCountLine({
        lineId: body.lineId,
        countedQuantity: Number(body.countedQuantity),
      })
      return Response.json(line)
    }

    if (body.action === 'post' && body.sessionId) {
      const session = await postStockCountSession(body.sessionId, undefined, user.id)
      return Response.json(session)
    }

    const session = await createStockCountSession({
      warehouseId: body.warehouseId,
      isCycleCount: body.isCycleCount ?? false,
      notes: body.notes,
      userId: user.id,
    })

    return Response.json(session, { status: 201 })
  } catch (error) {
    if (error instanceof InventoryError) {
      return Response.json({ error: error.message, code: error.code }, { status: 400 })
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('inventory.view', handleGet)
export const POST = guarded('inventory.edit', handlePost)
