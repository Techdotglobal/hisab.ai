import { authzErrorResponse } from '@/lib/authz'
import { requireAuth } from '@/lib/auth'
import { requirePermission } from '@/lib/permissions/server'
import { accessErrorResponse, getUserAccessDetail, previewUserAccess } from '@/lib/permissions/service'

/** Effective access (role baseline, individual grants, delegation, history) for one user. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const me = await requireAuth()
    // Everyone may see their own access; seeing anyone else's needs users.view_permissions.
    const ctx = await requirePermission(...(me.id === id ? [] : (['users.view_permissions'] as const)))
    return Response.json(await getUserAccessDetail(ctx, id))
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}

/** Dry-run: what would the user's access become? Writes nothing. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission('users.view_permissions')
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    return Response.json(await previewUserAccess(ctx, id, body))
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}
