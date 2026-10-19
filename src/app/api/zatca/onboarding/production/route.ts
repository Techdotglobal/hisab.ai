import { guarded } from '@/lib/permissions/guard'
import { requireZatcaAdmin } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { requestAndStoreProductionCsid } from '@/lib/zatca/onboarding/service'
import type { ZatcaEnvironment } from '@/lib/db/prisma-types'

/**
 * POST /api/zatca/onboarding/production
 * Body: { environment: 'SANDBOX' | 'PRODUCTION' }
 * Requests and stores Production CSID after compliance onboarding.
 */
async function handlePost(request: Request) {
  try {
    const user = await requireZatcaAdmin()
    const body = await request.json().catch(() => ({}))
    const environment = body?.environment as ZatcaEnvironment | undefined

    if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
      return Response.json({ error: 'environment must be SANDBOX or PRODUCTION' }, { status: 400 })
    }

    const result = await requestAndStoreProductionCsid(environment, { userId: user.id, userName: user.name })
    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof ZatcaForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 })
    }
    return Response.json({ error: String(error) }, { status: 422 })
  }
}

export const POST = guarded('integrations.manage', handlePost)
