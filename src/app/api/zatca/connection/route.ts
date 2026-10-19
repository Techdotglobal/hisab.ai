import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { getConnectionManagerSnapshot } from '@/lib/zatca/connection/manager'

async function handleGet() {
  try {
    await requireAuth()
    return Response.json(await getConnectionManagerSnapshot())
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

export const GET = guarded('integrations.manage', handleGet)
