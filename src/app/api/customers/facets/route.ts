import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getCustomerRepository } from '@/lib/db/provider'

async function handleGet() {
  try {
    await requireAuth()
    const facets = await getCustomerRepository().getFilterFacets()
    return Response.json(facets)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('customers.view', handleGet)
