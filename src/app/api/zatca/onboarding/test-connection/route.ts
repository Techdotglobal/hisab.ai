import { guarded } from '@/lib/permissions/guard'
import { requireZatcaAdmin } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { getSettingsRepository } from '@/lib/db/provider'
import { logZatcaAudit } from '@/lib/zatca/audit/logger'
import { testZatcaConnection } from '@/lib/zatca/onboarding/onboard'
import type { ZatcaEnvironment } from '@/lib/db/prisma-types'

/**
 * POST /api/zatca/onboarding/test-connection
 * Body: { environment: 'SANDBOX' | 'PRODUCTION' }
 */
async function handlePost(request: Request) {
  try {
    const user = await requireZatcaAdmin()
    const body = await request.json().catch(() => ({}))
    const environment = body?.environment as ZatcaEnvironment | undefined

    if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
      return Response.json({ error: 'environment must be SANDBOX or PRODUCTION' }, { status: 400 })
    }

    const settings = await getSettingsRepository().findFirst()
    const result = await testZatcaConnection(environment)

    await logZatcaAudit({
      action: 'CONNECTION_TEST',
      result: result.ok ? 'SUCCESS' : 'FAILED',
      message: result.message,
      userId: user.id,
      userName: user.name,
      companyName: settings?.companyName ?? null,
      metadata: {
        environment,
        hasPrivateKey: result.hasPrivateKey,
        hasCertificate: result.hasCertificate,
        hasSecret: result.hasSecret,
        failures: result.failures ?? [],
      },
    })

    return Response.json({
      ok: result.ok,
      message: result.message,
      hasPrivateKey: result.hasPrivateKey,
      hasCertificate: result.hasCertificate,
      hasSecret: result.hasSecret,
      failures: result.failures ?? [],
      environment,
    }, { status: result.ok ? 200 : 422 })
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
