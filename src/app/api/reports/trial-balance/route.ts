import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { resolveCompanyId } from '@/lib/tenant'
import { parseReportBound } from '@/lib/accounting/ledger-report-math'
import { buildTrialBalance } from '@/lib/accounting/trial-balance'
import { buildReportCacheKey, getCachedReport, setCachedReport } from '@/lib/accounting/report-cache'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const asOf = parseReportBound(searchParams.get('asOf'), 'end') ?? new Date()
    const from = parseReportBound(searchParams.get('from'), 'start')
    const to = parseReportBound(searchParams.get('to'), 'end')

    const cacheKey = buildReportCacheKey('trial-balance', companyId, {
      asOf: asOf.toISOString(),
      from: from?.toISOString(),
      to: to?.toISOString(),
    })
    const cached = getCachedReport<ReturnType<typeof buildTrialBalance>>(cacheKey)
    if (cached) return Response.json(cached)

    const report = await buildTrialBalance({ asOf, from, to, companyId })
    setCachedReport(cacheKey, report)

    return Response.json(report)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('reports.view', handleGet)
