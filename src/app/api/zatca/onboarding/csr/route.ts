import { guarded } from '@/lib/permissions/guard'
import { requireZatcaAdmin } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { generateAndStoreCsr } from '@/lib/zatca/onboarding/service'
import type { ZatcaEnvironment } from '@/lib/db/prisma-types'

/**
 * POST /api/zatca/onboarding/csr
 * Body: { environment: 'SANDBOX' | 'PRODUCTION' }
 * Generates a ZATCA CSR and stores encrypted credentials.
 */
async function handlePost(request: Request) {
  try {
    const user = await requireZatcaAdmin()
    const body = await request.json().catch(() => ({}))
    const environment = body?.environment as ZatcaEnvironment | undefined

    if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
      return Response.json({ error: 'environment must be SANDBOX or PRODUCTION' }, { status: 400 })
    }

    const result = await generateAndStoreCsr(environment, { userId: user.id, userName: user.name })
    return Response.json(result, { status: 201 })
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
