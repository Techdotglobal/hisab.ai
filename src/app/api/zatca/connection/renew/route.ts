import { guarded } from '@/lib/permissions/guard'
import { requireZatcaAdmin } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { getSettingsRepository } from '@/lib/db/provider'
import { logZatcaAudit } from '@/lib/zatca/audit/logger'
import type { ZatcaEnvironment } from '@/lib/db/prisma-types'

/**
 * POST /api/zatca/connection/renew
 * Records certificate renewal intent (does not call ZATCA).
 */
async function handlePost(request: Request) {
  try {
    const user = await requireZatcaAdmin()
    const body = await request.json().catch(() => ({}))
    const environment = body.environment as ZatcaEnvironment

    if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
      return Response.json({ error: 'environment must be SANDBOX or PRODUCTION' }, { status: 400 })
    }

    const settings = await getSettingsRepository().findFirst()
    await logZatcaAudit({
      action: 'CERTIFICATE_RENEWAL_STARTED',
      result: 'SUCCESS',
      message: `Certificate renewal started for ${environment}`,
      userId: user.id,
      userName: user.name,
      companyName: settings?.companyName ?? null,
      metadata: { environment },
    })

    return Response.json({
      success: true,
      message: 'Delete local credentials, then complete onboarding with a new OTP from the Fatoora portal.',
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof ZatcaForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('integrations.manage', handlePost)
