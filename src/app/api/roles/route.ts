import { authzErrorResponse } from '@/lib/authz'
import { PERMISSION_DEFS, ROLE_BASELINES } from '@/lib/permissions/catalog'
import { NON_OWNER_ROLES } from '@/lib/permissions/delegation'
import { requirePermission } from '@/lib/permissions/server'
import { publicRole } from '@/lib/supabase/auth-users'

/** Static catalog: roles, their baseline permissions, and the full permission list. */
export async function GET() {
  try {
    await requirePermission('roles.view')
    return Response.json({
      permissions: PERMISSION_DEFS,
      roles: [...NON_OWNER_ROLES, 'OWNER' as const].map((role) => ({
        role,
        displayRole: publicRole(role),
        permissions: ROLE_BASELINES[role],
      })),
    })
  } catch (error) {
    return authzErrorResponse(error)
  }
}
