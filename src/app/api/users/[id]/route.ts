import { authzErrorResponse, requireRole } from '@/lib/authz'
import { deleteAppUser, updateAppUser } from '@/lib/supabase/auth-users'

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireRole(['OWNER', 'ADMIN'])
    const { id } = await params
    const body = await request.json()

    const user = await updateAppUser(id, session.companyId, {
      name: body.name,
      role: body.role,
      isActive: body.isActive,
      password: body.password,
    })

    return Response.json(user)
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const currentUser = await requireRole(['OWNER', 'ADMIN'])
    const { id } = await params

    if (currentUser.id === id) {
      return Response.json({ error: 'Cannot delete your own account' }, { status: 400 })
    }

    await deleteAppUser(id, currentUser.companyId)
    return Response.json({ success: true })
  } catch (error) {
    return authzErrorResponse(error)
  }
}
