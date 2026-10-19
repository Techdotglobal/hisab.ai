import 'server-only'
import { ForbiddenError } from '@/lib/authz'
import { TenantAccessError } from '@/lib/tenant-error'
import type { PermissionKey } from './catalog'
import { requirePermission, requireAnyPermission } from './server'

/**
 * Wraps a route handler so the permission check runs BEFORE any handler code (and before the
 * request body is read). The handler keeps its own `requireAuth()` calls, so nothing downstream
 * changes; this is purely an additional, uniform gate.
 *
 *   async function GET_impl(req: Request) { ... }
 *   export const GET = guarded('invoices.view', GET_impl)
 *
 * Pass an array to allow any of several permissions.
 */
export function guarded<H extends (...args: never[]) => unknown>(
  permission: PermissionKey | PermissionKey[],
  handler: H,
): (...args: Parameters<H>) => Promise<Response> {
  return async (...args: Parameters<H>) => {
    try {
      if (Array.isArray(permission)) await requireAnyPermission(...permission)
      else await requirePermission(permission)
    } catch (error) {
      if (error instanceof Error && error.message === 'Unauthorized') {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      if (error instanceof ForbiddenError || error instanceof TenantAccessError) {
        return Response.json({ error: 'Forbidden' }, { status: 403 })
      }
      console.error('Authorization check failed', error)
      return Response.json({ error: 'Authorization check failed' }, { status: 500 })
    }
    return (await handler(...args)) as Response
  }
}
