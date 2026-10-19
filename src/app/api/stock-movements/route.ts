import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { listCompanyRows } from '@/lib/api/crud'
import {
  processInventoryMovement,
  processWarehouseTransfer,
  InventoryError,
} from '@/lib/inventory/movements'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const inventoryItemId = searchParams.get('inventoryItemId')
    const rows = await listCompanyRows('stock_movements', {
      orderBy: 'date',
      filters: inventoryItemId ? { inventory_item_id: inventoryItemId } : undefined,
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
    const {
      action,
      inventoryItemId,
      quantity,
      warehouseId,
      targetWarehouseId,
      unitCost,
      reference,
      movementType,
      sourceType,
      sourceId,
      lotId,
      serialId,
      batchNo,
      expiryDate,
    } = body

    if (!inventoryItemId || quantity === undefined) {
      return Response.json({ error: 'inventoryItemId and quantity are required' }, { status: 400 })
    }

    if (action === 'transfer') {
      if (!warehouseId || !targetWarehouseId) {
        return Response.json({ error: 'warehouseId and targetWarehouseId required for transfer' }, { status: 400 })
      }
      const result = await processWarehouseTransfer({
        inventoryItemId,
        fromWarehouseId: warehouseId,
        toWarehouseId: targetWarehouseId,
        quantity: Number(quantity),
        unitCost: unitCost !== undefined ? Number(unitCost) : undefined,
        reference,
        userId: user.id,
      })
      return Response.json({ result }, { status: 201 })
    }

    const typeMap: Record<string, string> = {
      receipt: 'RECEIPT',
      adjustment: 'ADJUSTMENT',
      issue: 'ISSUE',
      goods_receipt: 'GOODS_RECEIPT',
      goods_issue: 'GOODS_ISSUE',
      manufacturing_consumption: 'MANUFACTURING_CONSUMPTION',
      manufacturing_output: 'MANUFACTURING_OUTPUT',
    }

    const resolvedType = movementType ?? typeMap[action] ?? (action === 'receipt' ? 'RECEIPT' : 'ADJUSTMENT')
    const qty = action === 'adjustment' ? Number(quantity) : Math.abs(Number(quantity))

    const result = await processInventoryMovement({
      inventoryItemId,
      warehouseId: warehouseId || null,
      quantity: action === 'adjustment' ? Number(quantity) : qty,
      unitCost: unitCost !== undefined ? Number(unitCost) : undefined,
      movementType: resolvedType as 'RECEIPT',
      sourceType: sourceType ?? null,
      sourceId: sourceId ?? null,
      reference: reference ?? null,
      lotId: lotId ?? null,
      serialId: serialId ?? null,
      batchNo: batchNo ?? null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      userId: user.id,
      postCogsJournal: ['issue', 'goods_issue', 'manufacturing_consumption'].includes(action),
    })

    return Response.json({ movement: result }, { status: 201 })
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
