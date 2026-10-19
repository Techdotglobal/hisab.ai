import { guarded } from '@/lib/permissions/guard'
import { requireZatcaOwner } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { deleteLocalCredentials } from '@/lib/zatca/connection/credentials'
import type { ZatcaEnvironment } from '@/lib/db/prisma-types'

async function handlePost(request: Request) {
  try {
    const user = await requireZatcaOwner()
    const body = await request.json().catch(() => ({}))
    const environment = body.environment as ZatcaEnvironment
    const confirm = body.confirm === true

    if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
      return Response.json({ error: 'environment must be SANDBOX or PRODUCTION' }, { status: 400 })
    }

    if (!confirm) {
      return Response.json({ error: 'Confirmation required to delete local credentials' }, { status: 400 })
    }

    await deleteLocalCredentials(environment, {
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

export const POST = guarded('integrations.manage', handlePost)
