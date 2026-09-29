import { requireAuth } from '@/lib/auth'
import { getInventoryRepository } from '@/lib/db/provider'
import { prisma } from '@/lib/prisma'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const item = await getInventoryRepository().findById(id)
    if (!item) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(item)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const body = await request.json()

    const existing = await prisma.inventoryItem.findUnique({ where: { id, companyId } })
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const item = await prisma.inventoryItem.update({
      where: { id, companyId },
      data: {
        name: body.name ?? existing.name,
        description: body.description ?? existing.description,
        category: body.category ?? existing.category,
        unit: body.unit ?? existing.unit,
        costPrice: body.costPrice ?? existing.costPrice,
        salePrice: body.salePrice ?? existing.salePrice,
        quantity: body.quantity ?? existing.quantity,
        minQuantity: body.minQuantity ?? existing.minQuantity,
        isActive: body.isActive ?? existing.isActive,
      },
    })

    if (body.quantity !== undefined && Number(body.quantity) !== Number(existing.quantity)) {
      const delta = Number(body.quantity) - Number(existing.quantity)
      const movementNo = await getNextSequence('STOCK_MOVEMENT', 'SM-')
      const client = createAdminClient()

      const { error: movementError } = await client.from('stock_movements').insert({
        company_id: companyId,
        movement_no: movementNo,
        inventory_item_id: id,
        warehouse_id: body.warehouseId ?? null,
        movement_type: 'ADJUSTMENT',
        quantity: delta,
        unit_cost: Number(item.costPrice ?? 0),
        reference: body.adjustmentReference ?? 'Inventory quantity update',
        date: new Date().toISOString(),
      })

      if (movementError) throw movementError
    }

    return Response.json(item)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    await prisma.inventoryItem.delete({ where: { id, companyId } })
    return Response.json({ success: true })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
