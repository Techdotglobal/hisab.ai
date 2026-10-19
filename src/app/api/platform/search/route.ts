import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { globalSearch, getRecentSearches } from '@/lib/platform/search/global'

async function handleGet(request: Request) {
  try {
    const user = await requireAuth()
    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q') ?? ''
    const types = searchParams.get('types')?.split(',').filter(Boolean)

    if (searchParams.get('recent') === 'true') {
      const recent = await getRecentSearches(user.id)
      return Response.json({ recent })
    }

    const result = await globalSearch(q, {
      userId: user.id,
      entityTypes: types,
      limit: Number(searchParams.get('limit') ?? 20),
    })
    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
