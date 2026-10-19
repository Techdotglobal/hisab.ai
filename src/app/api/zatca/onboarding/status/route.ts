import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getSettingsRepository } from '@/lib/db/provider'
import { resolveCompanyId, supabaseDb } from '@/lib/db/repository-utils'
import { getOnboardingStatus } from '@/lib/zatca/onboarding/service'

async function getLatestComplianceStatus() {
  const companyId = await resolveCompanyId()
  const { data, error } = await supabaseDb()
    .from('zatca_audit_logs')
    .select('metadata, created_at')
    .eq('company_id', companyId)
    .eq('action', 'COMPLIANCE_CHECKS_COMPLETED')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  const metadata = data?.metadata as {
    passed?: boolean
    results?: Array<{
      scenario: string
      passed: boolean
      validationStatus?: string
      error?: string
      requestId?: string
    }>
  } | null

  return {
    passed: metadata?.passed ?? null,
    results: metadata?.results ?? [],
    createdAt: data?.created_at ?? null,
  }
}

/**
 * GET /api/zatca/onboarding/status
 * Returns onboarding status for the active ZATCA environment (no secrets).
 */
async function handleGet() {
  try {
    await requireAuth()

    const settings = await getSettingsRepository().findFirst()
    const environment = settings?.zatcaEnvironment ?? 'SANDBOX'
    const [status, compliance] = await Promise.all([
      getOnboardingStatus(environment),
      getLatestComplianceStatus(),
    ])

    return Response.json({
      zatcaEnabled: settings?.zatcaEnabled ?? false,
      connectedAt: settings?.zatcaConnectedAt?.toISOString() ?? null,
      companyName: settings?.companyName ?? null,
      taxId: settings?.taxId ?? null,
      commercialRegistration: settings?.commercialRegistration ?? null,
      compliance,
      ...status,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
