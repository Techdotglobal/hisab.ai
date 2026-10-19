import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getSettingsRepository } from '@/lib/db/provider'
import { getCertificateStatus } from '@/lib/zatca/onboarding/certificate-status'

/**
 * GET /api/zatca/onboarding/certificate-status
 * Returns non-sensitive certificate lifecycle metadata.
 */
async function handleGet() {
  try {
    await requireAuth()
    const settings = await getSettingsRepository().findFirst()
    const environment = settings?.zatcaEnvironment ?? 'SANDBOX'
    return Response.json(await getCertificateStatus(environment))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
