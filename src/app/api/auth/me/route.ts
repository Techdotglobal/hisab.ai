import { requireAuth } from '@/lib/auth'
import { TenantAccessError } from '@/lib/tenant'
import { ForbiddenError } from '@/lib/authz'
import { listEffective } from '@/lib/permissions/catalog'
import { authorityOf } from '@/lib/permissions/delegation'
import { requirePermission } from '@/lib/permissions/server'

export async function GET() {
  try {
    const user = await requireAuth()
    // Effective permissions let the UI show only actions the backend will actually allow.
    const ctx = await requirePermission()
    const authority = authorityOf(ctx.principal)
    return Response.json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      companyName: user.companyName,
      country: user.country,
      currency: user.currency,
      avatarUrl: user.avatarUrl,
      permissions: listEffective(ctx.snapshot.access).map((e) => e.permission),
      isDelegate: Boolean(ctx.snapshot.delegation),
      authority: { manageableRoles: [...authority.manageableRoles], delegable: [...authority.delegable] },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof ForbiddenError) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (error instanceof TenantAccessError) {
      return Response.json({ error: error.message }, { status: 403 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
