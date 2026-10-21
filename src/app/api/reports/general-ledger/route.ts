import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getGeneralLedgerReport } from '@/lib/accounting/ledger'
import { isLedgerSourceType } from '@/lib/accounting/ledger-source-types'
import { isValidIsoDate, validateDateRange } from '@/lib/reporting/period-presets'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const accountId = searchParams.get('accountId') || undefined
    const today = new Date().toISOString().slice(0, 10)
    const from = searchParams.get('from') || `${today.slice(0, 4)}-01-01`
    const to = searchParams.get('to') || today
    const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 500
    const offset = searchParams.get('offset') ? Number(searchParams.get('offset')) : 0

    if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
      return Response.json({ error: 'from and to must be valid YYYY-MM-DD dates' }, { status: 400 })
    }
    const rangeError = validateDateRange(from, to)
    if (rangeError) return Response.json({ error: rangeError }, { status: 400 })
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000 || !Number.isInteger(offset) || offset < 0) {
      return Response.json({ error: 'Invalid limit or offset' }, { status: 400 })
    }

    const sourceTypes = (searchParams.get('sourceType') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const invalid = sourceTypes.find((t) => !isLedgerSourceType(t))
    if (invalid) return Response.json({ error: `Unknown transaction class: ${invalid}` }, { status: 400 })

    const report = await getGeneralLedgerReport({
      accountId,
      from,
      to,
      limit,
      offset,
      sourceTypes,
      skipAggregates: searchParams.get('aggregates') === '0',
    })

    return Response.json(report)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('ledger.view', handleGet)
