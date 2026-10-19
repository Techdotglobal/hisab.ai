import { guarded } from '@/lib/permissions/guard'
import { requireZatcaAdmin } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { mapOnboardingError } from '@/lib/zatca/onboarding/onboarding-errors'
import { runZatcaOnboarding } from '@/lib/zatca/onboarding/onboard'
import type { ZatcaEnvironment } from '@/lib/db/prisma-types'

/**
 * POST /api/zatca/onboard
 * Body: { otp: string, environment?: 'SANDBOX' | 'PRODUCTION' }
 */
async function handlePost(request: Request) {
  try {
    const user = await requireZatcaAdmin()
    const body = await request.json()
    const otp = body?.otp
    const environment = body?.environment as ZatcaEnvironment | undefined

    if (!otp || typeof otp !== 'string') {
      return Response.json({ error: 'OTP is required', code: 'INVALID_OTP' }, { status: 400 })
    }

    const result = await runZatcaOnboarding(
      { otp, environment },
      { userId: user.id, userName: user.name },
    )

    return Response.json(result, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
    }
    if (error instanceof ZatcaForbiddenError) {
      return Response.json({ error: error.message, code: 'FORBIDDEN' }, { status: 403 })
    }

    const mapped = mapOnboardingError(error)
    const raw = error instanceof Error ? error.message : String(error)
    const code = (error as Error & { code?: string }).code ?? mapped.code
    return Response.json(
      { error: mapped.code === 'UNKNOWN' ? raw : mapped.message, code },
      { status: mapped.httpStatus },
    )
  }
}

export const POST = guarded('integrations.manage', handlePost)
