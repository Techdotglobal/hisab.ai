import { authzErrorResponse } from '@/lib/authz'
import { requirePermission } from '@/lib/permissions/server'
import { accessErrorResponse, grantPermissionAsActor, revokePermissionAsActor } from '@/lib/permissions/service'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission('permissions.manage')
    const { id } = await params
    const body = await request.json()
    await grantPermissionAsActor(ctx, id, { permission: body.permission, scope: body.scope, reason: body.reason }, request)
    return Response.json({ success: true }, { status: 201 })
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission('permissions.manage')
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    await revokePermissionAsActor(ctx, id, body.permission, body.reason, request)
    return Response.json({ success: true })
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}
