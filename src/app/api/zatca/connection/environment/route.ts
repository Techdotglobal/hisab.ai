import { guarded } from '@/lib/permissions/guard'
import { requireZatcaAdmin } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { setActiveZatcaEnvironment } from '@/lib/zatca/connection/credentials'
import type { ZatcaEnvironment } from '@/lib/db/prisma-types'

async function handlePut(request: Request) {
  try {
    const user = await requireZatcaAdmin()
    const body = await request.json().catch(() => ({}))
    const environment = body.environment as ZatcaEnvironment

    if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
      return Response.json({ error: 'environment must be SANDBOX or PRODUCTION' }, { status: 400 })
    }

    await setActiveZatcaEnvironment(environment, {
      userId: user.id,
      userName: user.name,
    })

    return Response.json({ success: true, environment })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof ZatcaForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const PUT = guarded('integrations.manage', handlePut)
