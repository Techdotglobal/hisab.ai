import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, getCompanyRow, insertCompanyRow, listCompanyRows, updateCompanyRow } from '@/lib/api/crud'
import { getNextSequence } from '@/lib/sequences'

async function handleGet() {
  try {
    await requireAuth()
    const rows = await listCompanyRows('fixed_assets', { orderBy: 'purchase_date', ascending: false })
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
    const body = await request.json()
    if (!body.name || !body.purchaseDate || body.purchaseCost === undefined) {
      return Response.json({ error: 'name, purchaseDate, purchaseCost are required' }, { status: 400 })
    }

    const assetNo = await getNextSequence('FIXED_ASSET', 'FA-')
    const row = await insertCompanyRow('fixed_assets', {
      asset_no: assetNo,
      name: body.name,
      purchase_date: new Date(body.purchaseDate).toISOString(),
      purchase_cost: body.purchaseCost,
      salvage_value: body.salvageValue ?? 0,
      useful_life_months: body.usefulLifeMonths ?? 60,
      depreciation_method: body.depreciationMethod ?? 'STRAIGHT_LINE',
      accumulated_depreciation: body.accumulatedDepreciation ?? 0,
      account_id: body.accountId || null,
      status: body.status ?? 'ACTIVE',
    })
    return Response.json(row, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 })

    const existing = await getCompanyRow('fixed_assets', body.id)
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const row = await updateCompanyRow('fixed_assets', body.id, {
      name: body.name ?? existing.name,
      purchase_date: body.purchaseDate ? new Date(body.purchaseDate).toISOString() : existing.purchase_date,
      purchase_cost: body.purchaseCost ?? existing.purchase_cost,
      salvage_value: body.salvageValue ?? existing.salvage_value,
      useful_life_months: body.usefulLifeMonths ?? existing.useful_life_months,
      depreciation_method: body.depreciationMethod ?? existing.depreciation_method,
      accumulated_depreciation: body.accumulatedDepreciation ?? existing.accumulated_depreciation,
      account_id: body.accountId ?? existing.account_id,
      status: body.status ?? existing.status,
    })
    return Response.json(row)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
    await deleteCompanyRow('fixed_assets', id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('fixed_assets.view', handleGet)
export const POST = guarded('fixed_assets.manage', handlePost)
export const PUT = guarded('fixed_assets.manage', handlePut)
export const DELETE = guarded('fixed_assets.manage', handleDelete)
