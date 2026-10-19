import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getCurrencySettings, upsertCurrencySettings, getCurrencyRoles } from '@/lib/currency/fx-accounts'

async function handleGet() {
  try {
    await requireAuth()
    const [settings, roles] = await Promise.all([
      getCurrencySettings(),
      getCurrencyRoles(),
    ])
    return Response.json({ settings, roles })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePatch(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    const settings = await upsertCurrencySettings({
      realizedGainAccountId: body.realizedGainAccountId,
      realizedLossAccountId: body.realizedLossAccountId,
      unrealizedGainAccountId: body.unrealizedGainAccountId,
      unrealizedLossAccountId: body.unrealizedLossAccountId,
      autoFetchRates: body.autoFetchRates,
    })
    return Response.json(settings)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('settings.view', handleGet)
export const PATCH = guarded('settings.manage', handlePatch)
