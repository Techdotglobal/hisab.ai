import { requireAuth } from '@/lib/auth'
import { guarded } from '@/lib/permissions/guard'
import { serializeCostCenter } from '@/lib/cost-centers/api-serialize'
import { getCostCenterRepository } from '@/lib/db/provider'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? ''
    const type = searchParams.get('type') ?? undefined
    const includeMetadata = searchParams.get('includeMetadata') === 'true'
    // Cost Centers UI needs top-level cost without requiring full metadata on the wire
    const includeCost = searchParams.get('includeCost') === 'true' || includeMetadata

    const centers = await getCostCenterRepository().findMany({
      search: search || undefined,
      type: type || undefined,
      activeOnly: searchParams.get('activeOnly') === 'true',
      // Load metadata whenever we need to derive Cost for PROJECT rows
      includeMetadata: includeCost || includeMetadata,
    })

    return Response.json(
      centers.map((center) =>
        serializeCostCenter(center, { includeMetadata }),
      ),
    )
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
      return Response.json({ error: 'Cost center name is required' }, { status: 400 })
    }

    const { mergeProjectCostIntoMetadata } = await import('@/lib/cost-centers/api-serialize')
    const type = body.type || 'PROJECT'
    let metadata = body.metadata ?? {}
    if (type === 'PROJECT' && body.cost !== undefined) {
      metadata = mergeProjectCostIntoMetadata(metadata, body.cost)
    }

    const center = await getCostCenterRepository().create({
      code: body.code,
      name,
      type,
      description: body.description,
      metadata,
    })

    return Response.json(serializeCostCenter(center, { includeMetadata: true }), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('cost_centers.view', handleGet)
export const POST = guarded('cost_centers.manage', handlePost)
