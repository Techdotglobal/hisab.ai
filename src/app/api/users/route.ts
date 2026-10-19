import { authzErrorResponse } from '@/lib/authz'
import { requirePermission } from '@/lib/permissions/server'
import { accessErrorResponse, createUserAsActor, listUsersWithAccess } from '@/lib/permissions/service'

export async function GET() {
  try {
    const ctx = await requirePermission('users.view')
    return Response.json(await listUsersWithAccess(ctx.companyId))
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requirePermission('users.create')
    const body = await request.json()
    const user = await createUserAsActor(
      ctx,
      { email: body.email, password: body.password, name: body.name, role: body.role },
      request,
    )
    return Response.json(user, { status: 201 })
  } catch (error) {
    return accessErrorResponse(error) ?? authzErrorResponse(error)
  }
}
