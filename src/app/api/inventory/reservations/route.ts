import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createInventoryReservation, releaseInventoryReservation } from '@/lib/inventory/reservations'
import { InventoryError } from '@/lib/inventory/movements'
import { listCompanyRows } from '@/lib/api/crud'

async function handleGet() {
  try {
    await requireAuth()
    const rows = await listCompanyRows('inventory_reservations', { orderBy: 'reserved_at' })
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

    if (body.action === 'release' && body.reservationId) {
      const result = await releaseInventoryReservation(body.reservationId, undefined, user.id)
      return Response.json(result)
    }

    const reservation = await createInventoryReservation({
      inventoryItemId: body.inventoryItemId,
      warehouseId: body.warehouseId,
      quantity: Number(body.quantity),
      sourceType: body.sourceType ?? 'MANUAL',
      sourceId: body.sourceId ?? crypto.randomUUID(),
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      notes: body.notes,
      userId: user.id,
    })

    return Response.json(reservation, { status: 201 })
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
