import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse } from '@/lib/authz'
import { listConnectors, listConnections, createConnection } from '@/lib/platform/integrations/registry'
import { requirePlatformAdmin } from '@/lib/platform/require-admin'

async function handleGet() {
  try {
    await requireAuth()
    const [connectors, connections] = await Promise.all([listConnectors(), listConnections()])
    return Response.json({ connectors, connections })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

async function handlePost(request: Request) {
  try {
    await requirePlatformAdmin()
    const body = await request.json()
    const connection = await createConnection({
      connectorKey: body.connectorKey,
      name: body.name,
      credentials: body.credentials,
      settings: body.settings,
    })
    return Response.json(connection, { status: 201 })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export const GET = guarded('integrations.manage', handleGet)
export const POST = guarded('integrations.manage', handlePost)
