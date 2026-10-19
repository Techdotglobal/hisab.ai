import { authzErrorResponse } from '@/lib/authz'
import { requirePermission } from '@/lib/permissions/server'
import { accessErrorResponse, revokeDelegationAsOwner, setDelegationAsOwner } from '@/lib/permissions/service'

// Appointing / revoking a delegate is owner-only (enforced in the service, not just here).
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission('permissions.manage')
    const { id } = await params
    const body = await request.json()
    const delegation = await setDelegationAsOwner(
      ctx,
      id,
      { manageableRoles: body.manageableRoles, delegable: body.delegable, note: body.note },
      request,
    )
    return Response.json(delegation)
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission('permissions.manage')
    const { id } = await params
    await revokeDelegationAsOwner(ctx, id, request)
    return Response.json({ success: true })
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}
