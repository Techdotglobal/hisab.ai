import 'server-only'
import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { ForbiddenError, requireRole } from '@/lib/authz'
import { requirePermission } from '@/lib/permissions/server'
import type { PermissionKey } from '@/lib/permissions/catalog'
import type { AppUser } from '@/lib/auth'
import type { CompanyRole } from '@/lib/db/types'
import { logger } from '@/lib/ops/logger'
import { AccountingIntegrationException } from '../utils/exceptions'
import { IntegrationPermission } from './permissions'
import { integrationErrorLogContext } from './error-logging'

const COMPANY_ROLES: CompanyRole[] = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'EMPLOYEE', 'AUDITOR']

const INTEGRATION_PERMISSION_MAP: Record<IntegrationPermission, PermissionKey> = {
  [IntegrationPermission.VIEW]: 'imports.view',
  [IntegrationPermission.CONNECT]: 'integrations.manage',
  [IntegrationPermission.DISCONNECT]: 'integrations.manage',
  [IntegrationPermission.MANAGE]: 'integrations.manage',
}

export interface IntegrationRequestContext {
  request: Request
  user: AppUser
  tenantId: string
  correlationId: string
}

export function integrationApiHandler(
  route: string,
  permission: IntegrationPermission,
  handler: (context: IntegrationRequestContext) => Promise<Response>,
) {
  return async function handle(request: Request): Promise<Response> {
    const startedAt = Date.now()
    const correlationId = randomUUID()
    let context: Partial<IntegrationRequestContext> = { correlationId, request }
    try {
      const user = await requireRole(COMPANY_ROLES)
      context = { correlationId, request, user, tenantId: user.companyId }
      // Central RBAC (individual grants + delegation aware) replaces the old static role map.
      await requirePermission(INTEGRATION_PERMISSION_MAP[permission])
      const handlerResponse = await handler(context as IntegrationRequestContext)
      const response = new NextResponse(handlerResponse.body, {
        status: handlerResponse.status,
        statusText: handlerResponse.statusText,
        headers: handlerResponse.headers,
      })
      response.headers.set('x-correlation-id', correlationId)
      logger.info('accounting.integration.api', {
        correlationId,
        companyId: user.companyId,
        userId: user.id,
        route,
        method: route.split(' ')[0],
        statusCode: response.status,
        integrationResult: response.headers.get('x-integration-result') ?? undefined,
        durationMs: Date.now() - startedAt,
      })
      return response
    } catch (error) {
      const response = integrationErrorResponse(error, correlationId)
      logger.error('accounting.integration.api', {
        correlationId,
        companyId: context.tenantId,
        userId: context.user?.id,
        route,
        method: route.split(' ')[0],
        statusCode: response.status,
        errorCode: error instanceof AccountingIntegrationException ? error.code : undefined,
        ...integrationErrorLogContext(error),
        durationMs: Date.now() - startedAt,
      })
      return response
    }
  }
}

export function integrationErrorResponse(error: unknown, correlationId: string): Response {
  let status = 500
  let code = 'INTERNAL_ERROR'
  let message = 'Unable to process the integration request.'

  if (error instanceof AccountingIntegrationException) {
    status = error.statusCode
    code = error.code
    message = error.message
  } else if (error instanceof ForbiddenError) {
    status = 403
    code = 'UNAUTHORIZED_INTEGRATION'
    message = 'You do not have permission to access accounting integrations.'
  } else if (error instanceof Error && error.message === 'Unauthorized') {
    status = 401
    code = 'UNAUTHORIZED'
    message = 'Authentication required.'
  }

  return Response.json({ error: { code, message, correlationId } }, {
    status,
    headers: { 'x-correlation-id': correlationId },
  })
}
