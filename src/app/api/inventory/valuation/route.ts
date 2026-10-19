import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { buildInventoryValuationReport, recalculateWeightedAverageCosts } from '@/lib/inventory/valuation'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const warehouseId = searchParams.get('warehouseId') ?? undefined
    const asOf = searchParams.get('asOf') ? new Date(searchParams.get('asOf')!) : undefined

    const report = await buildInventoryValuationReport({ warehouseId, asOf })
    return Response.json(report)
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
    if (body.action === 'recalculate_wac') {
      const result = await recalculateWeightedAverageCosts()
      return Response.json(result)
    }
    return Response.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('inventory.view', handleGet)
export const POST = guarded('inventory.edit', handlePost)
