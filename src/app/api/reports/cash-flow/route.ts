import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { parseReportBound } from '@/lib/accounting/ledger-report-math'
import { buildCashFlowFromLedger } from '@/lib/accounting/cash-flow'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const from = parseReportBound(searchParams.get('from'), 'start') ?? new Date(new Date().getFullYear(), 0, 1)
    const to = parseReportBound(searchParams.get('to'), 'end') ?? new Date()

    const report = await buildCashFlowFromLedger({ from, to })

    return Response.json(report)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('reports.view', handleGet)
