import { guarded } from '@/lib/permissions/guard'
import { requireZatcaAdmin } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { mapOnboardingError } from '@/lib/zatca/onboarding/onboarding-errors'
import { submitComplianceOnboarding } from '@/lib/zatca/onboarding/service'
import type { ZatcaEnvironment } from '@/lib/db/prisma-types'

/**
 * POST /api/zatca/onboarding/compliance
 * Body: { otp: string, environment: 'SANDBOX' | 'PRODUCTION' }
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

    if (environment !== 'SANDBOX' && environment !== 'PRODUCTION') {
      return Response.json({ error: 'environment must be SANDBOX or PRODUCTION' }, { status: 400 })
    }

    const result = await submitComplianceOnboarding(environment, otp, { userId: user.id, userName: user.name })
    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
    }
    if (error instanceof ZatcaForbiddenError) {
      return Response.json({ error: error.message, code: 'FORBIDDEN' }, { status: 403 })
    }
    const mapped = mapOnboardingError(error)
    return Response.json({ error: mapped.message, code: mapped.code }, { status: mapped.httpStatus })
  }
}

export const POST = guarded('integrations.manage', handlePost)
