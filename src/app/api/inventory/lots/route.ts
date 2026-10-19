import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { listCompanyRows } from '@/lib/api/crud'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const itemId = searchParams.get('inventoryItemId')
    const rows = await listCompanyRows('inventory_lots', {
      orderBy: 'created_at',
      filters: itemId ? { inventory_item_id: itemId } : undefined,
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
    await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const lotNo = String(body.lotNo ?? '').trim()
    if (!lotNo || !body.inventoryItemId || !body.warehouseId) {
      return Response.json({ error: 'lotNo, inventoryItemId, warehouseId required' }, { status: 400 })
    }

    const client = createAdminClient()
    const { data, error } = await client
      .from('inventory_lots')
      .insert({
        company_id: companyId,
        inventory_item_id: body.inventoryItemId,
        warehouse_id: body.warehouseId,
        lot_no: lotNo,
        batch_no: body.batchNo ?? null,
        quantity: Number(body.quantity ?? 0),
        unit_cost: Number(body.unitCost ?? 0),
        expiry_date: body.expiryDate ?? null,
        manufactured_date: body.manufacturedDate ?? null,
      })
      .select('*')
      .single()

    if (error) throw error
    return Response.json(data, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('inventory.view', handleGet)
export const POST = guarded('inventory.edit', handlePost)
