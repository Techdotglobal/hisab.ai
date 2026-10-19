import { authzErrorResponse } from '@/lib/authz'
import { requireAnyPermission } from '@/lib/permissions/server'
import { accessErrorResponse, deleteUserAsActor, updateUserAsActor } from '@/lib/permissions/service'

// The specific capability (users.edit / roles.assign / users.deactivate) is checked per field inside
// updateUserAsActor against the target's real, company-scoped membership.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireAnyPermission('users.edit', 'roles.assign', 'users.deactivate')
    const { id } = await params
    const body = await request.json()
    const user = await updateUserAsActor(
      ctx,
      id,
      { name: body.name, role: body.role, isActive: body.isActive, password: body.password },
      request,
    )
    return Response.json(user)
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireAnyPermission('users.deactivate')
    const { id } = await params
    await deleteUserAsActor(ctx, id, request)
    return Response.json({ success: true })
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}
