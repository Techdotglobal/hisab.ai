import { requireAuth } from '@/lib/auth'
import { guarded } from '@/lib/permissions/guard'
import { getInventoryRepository } from '@/lib/db/provider'
import { prisma } from '@/lib/prisma'
import { getNextSequence } from '@/lib/sequences'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? undefined
    const items = await getInventoryRepository().findMany({ search })
    return Response.json(items)
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
    const name = typeof body.name === 'string' ? body.name.trim() : ''

    if (!name) {
      return Response.json({ error: 'Item name is required' }, { status: 400 })
    }

    const itemCode = await getNextSequence('ITEM', 'ITEM-')

    const item = await prisma.inventoryItem.create({
      data: {
        itemCode: body.itemCode || itemCode,
        name,
        description: body.description,
        category: body.category,
        unit: body.unit || 'PCS',
        costPrice: body.costPrice || 0,
        salePrice: body.salePrice || 0,
        quantity: body.quantity || 0,
        minQuantity: body.minQuantity || 0,
      },
    })

    return Response.json(item, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('inventory.view', handleGet)
export const POST = guarded('inventory.edit', handlePost)
