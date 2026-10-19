import { guarded } from '@/lib/permissions/guard'
import { authzErrorResponse, requireRole } from '@/lib/authz'
import {
  QUICKBOOKS_VALIDATION_MODULES,
  type QuickBooksValidationModule,
} from '@/lib/quickbooks-validation/types'
import { validateQuickBooksImports } from '@/lib/quickbooks-validation/service'

const ADMIN_ROLES = ['OWNER', 'ADMIN'] as const

async function handlePost(request: Request) {
  try {
    const user = await requireRole([...ADMIN_ROLES])
    const body = await request.json() as { modules?: unknown }
    const allowed = new Set<string>(QUICKBOOKS_VALIDATION_MODULES)
    const modules = Array.isArray(body.modules)
      ? [...new Set(body.modules.filter((item): item is QuickBooksValidationModule => typeof item === 'string' && allowed.has(item)))]
      : []
    if (modules.length === 0 || modules.length > QUICKBOOKS_VALIDATION_MODULES.length) {
      return Response.json({ error: 'Select one or more valid QuickBooks modules.' }, { status: 400 })
    }
    return Response.json(await validateQuickBooksImports(user.companyId, user.id, modules), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export const POST = guarded('integrations.manage', handlePost)
