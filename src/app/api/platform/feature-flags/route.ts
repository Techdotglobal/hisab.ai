import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { listFeatureFlags, isFeatureEnabled, setFeatureOverride } from '@/lib/platform/feature-flags/resolver'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const flagKey = searchParams.get('flag')

    if (flagKey) {
      const companyId = await resolveCompanyId()
      const enabled = await isFeatureEnabled(flagKey, { companyId })
      return Response.json({ flagKey, enabled })
    }

    const flags = await listFeatureFlags()
    return Response.json({ flags })
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
    const override = await setFeatureOverride({
      flagKey: body.flagKey,
      isEnabled: body.isEnabled,
      branchId: body.branchId,
      userId: body.userId,
    })
    return Response.json(override, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('integrations.manage', handleGet)
export const POST = guarded('integrations.manage', handlePost)
