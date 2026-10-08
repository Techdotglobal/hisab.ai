import { authzErrorResponse, requireRole } from '@/lib/authz'
import { fromDisplayRole, transferCompanyOwnership } from '@/lib/supabase/auth-users'

/**
 * Transfers company ownership to an existing, active member and assigns the previous owner
 * a new role, atomically (migration 080's transfer_company_ownership). Strictly OWNER-only —
 * unlike every other /api/users route, ADMIN cannot call this, so an admin can never promote
 * themselves (or anyone else) to Owner.
 */
export async function POST(request: Request) {
  try {
    const session = await requireRole(['OWNER'])
    const body = await request.json()

    if (!body.newOwnerUserId || typeof body.newOwnerUserId !== 'string') {
      return Response.json({ error: 'newOwnerUserId is required' }, { status: 400 })
    }
    if (body.newOwnerUserId === session.id) {
      return Response.json({ error: 'You are already the Owner' }, { status: 400 })
    }
    if (!body.previousOwnerNewRole || typeof body.previousOwnerNewRole !== 'string') {
      return Response.json({ error: 'previousOwnerNewRole is required' }, { status: 400 })
    }
    let previousOwnerNewRole
    try {
      previousOwnerNewRole = fromDisplayRole(body.previousOwnerNewRole)
    } catch (roleError) {
      return Response.json({ error: roleError instanceof Error ? roleError.message : String(roleError) }, { status: 400 })
    }

    await transferCompanyOwnership({
      companyId: session.companyId,
      newOwnerUserId: body.newOwnerUserId,
      previousOwnerNewRole,
    })

    return Response.json({ success: true })
  } catch (error) {
    return authzErrorResponse(error)
  }
}
