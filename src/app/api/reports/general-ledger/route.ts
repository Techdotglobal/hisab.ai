import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getGeneralLedgerReport } from '@/lib/accounting/ledger'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const accountId = searchParams.get('accountId') ?? undefined
    const from = searchParams.get('from') ? new Date(searchParams.get('from')!) : new Date(new Date().getFullYear(), 0, 1)
    const to = searchParams.get('to') ? new Date(searchParams.get('to')!) : new Date()
    const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 500
    const offset = searchParams.get('offset') ? Number(searchParams.get('offset')) : 0

    const report = await getGeneralLedgerReport({ accountId, from, to, limit, offset })

    return Response.json(report)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('ledger.view', handleGet)
