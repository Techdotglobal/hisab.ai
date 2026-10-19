import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { runReport } from '@/lib/reporting/runner'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const view = searchParams.get('view') ?? 'dashboard'

    if (view === 'dashboard') {
      const from = searchParams.get('from') ?? new Date(new Date().getFullYear(), 0, 1).toISOString()
      const to = searchParams.get('to') ?? new Date().toISOString()
      const result = await runReport({
        reportKey: 'executive-dashboard',
        period: { from, to, preset: 'custom' },
      })
      return Response.json(result.data)
    }

    const reportKey = searchParams.get('reportKey')
    if (!reportKey) {
      return Response.json({ error: 'reportKey required for analytics view' }, { status: 400 })
    }

    const result = await runReport({
      reportKey,
      period: searchParams.get('from') && searchParams.get('to')
        ? { from: searchParams.get('from')!, to: searchParams.get('to')!, preset: 'custom' }
        : undefined,
    })
    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('reports.view', handleGet)
