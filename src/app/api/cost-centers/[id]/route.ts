import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import {
  mergeProjectCostIntoMetadata,
  serializeCostCenter,
} from '@/lib/cost-centers/api-serialize'
import { getCostCenterRepository } from '@/lib/db/provider'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const center = await getCostCenterRepository().findById(id)
    if (!center) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    return Response.json(serializeCostCenter(center, { includeMetadata: true }))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const body = await request.json()
    const repo = getCostCenterRepository()
    const existing = await repo.findById(id)
    if (!existing) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    const nextType = body.type ?? existing.type
    let metadata =
      body.metadata !== undefined ? body.metadata : existing.metadata

    if (nextType === 'PROJECT' && body.cost !== undefined) {
      metadata = mergeProjectCostIntoMetadata(
        body.metadata !== undefined ? body.metadata : existing.metadata,
        body.cost,
      )
    }

    const center = await repo.update(id, {
      name: body.name,
      type: body.type,
      description: body.description,
      isActive: body.isActive,
      metadata,
    })
    return Response.json(serializeCostCenter(center, { includeMetadata: true }))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof Error && error.message === 'Cost center not found') {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    await getCostCenterRepository().delete(id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof Error && error.message === 'Cost center not found') {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('cost_centers.view', handleGet)
export const PUT = guarded('cost_centers.manage', handlePut)
export const DELETE = guarded('cost_centers.manage', handleDelete)
