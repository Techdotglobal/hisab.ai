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
    const status = searchParams.get('status')
    const filters: Record<string, string> = {}
    if (itemId) filters.inventory_item_id = itemId
    if (status) filters.status = status
    const rows = await listCompanyRows('inventory_serials', {
      orderBy: 'created_at',
      filters: Object.keys(filters).length ? filters : undefined,
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
    const serialNo = String(body.serialNo ?? '').trim()
    if (!serialNo || !body.inventoryItemId) {
      return Response.json({ error: 'serialNo and inventoryItemId required' }, { status: 400 })
    }

    const client = createAdminClient()
    const { data, error } = await client
      .from('inventory_serials')
      .insert({
        company_id: companyId,
        inventory_item_id: body.inventoryItemId,
        warehouse_id: body.warehouseId ?? null,
        lot_id: body.lotId ?? null,
        serial_no: serialNo,
        status: body.status ?? 'AVAILABLE',
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
