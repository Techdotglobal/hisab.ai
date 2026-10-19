import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { parseReportBound } from '@/lib/accounting/ledger-report-math'
import { buildBalanceSheetFromLedger } from '@/lib/accounting/trial-balance'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const asOf = parseReportBound(searchParams.get('asOf'), 'end') ?? new Date()

    const report = await buildBalanceSheetFromLedger({ asOf })

    return Response.json(report)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('reports.view', handleGet)
