import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { previewCurrencyRevaluation, runCurrencyRevaluation } from '@/lib/currency/revaluation'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const asOf = searchParams.get('asOf') ?? new Date().toISOString()
    const preview = await previewCurrencyRevaluation(new Date(asOf))
    return Response.json(preview)
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
    const asOf = body.asOf ? new Date(body.asOf) : new Date()
    const result = await runCurrencyRevaluation({
      revaluationDate: asOf,
      userId: user.id,
      notes: body.notes ?? null,
    })
    return Response.json(result, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 400 })
  }
}

export const GET = guarded('settings.view', handleGet)
export const POST = guarded('settings.manage', handlePost)
