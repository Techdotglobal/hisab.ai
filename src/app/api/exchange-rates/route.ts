import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { listExchangeRates, upsertExchangeRate, lookupExchangeRate } from '@/lib/currency/exchange-rates'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const fromCurrency = searchParams.get('from') ?? undefined
    const toCurrency = searchParams.get('to') ?? undefined
    const asOf = searchParams.get('asOf')

    if (fromCurrency && toCurrency && asOf) {
      const lookup = await lookupExchangeRate({
        fromCurrency,
        toCurrency,
        asOf: new Date(asOf),
      })
      return Response.json(lookup)
    }

    const rates = await listExchangeRates(undefined, {
      fromCurrency,
      toCurrency,
      limit: Number(searchParams.get('limit') ?? 100),
    })
    return Response.json(rates)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()
    const rate = await upsertExchangeRate({
      fromCurrency: body.fromCurrency,
      toCurrency: body.toCurrency,
      rate: Number(body.rate),
      effectiveDate: body.effectiveDate ? new Date(body.effectiveDate) : undefined,
      source: body.source,
      isManualOverride: body.isManualOverride ?? false,
      notes: body.notes,
      createdById: user.id,
    })
    return Response.json(rate, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('settings.view', handleGet)
export const POST = guarded('settings.manage', handlePost)
