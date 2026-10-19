import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { upsertNumberingSeries } from '@/lib/platform/numbering/engine'

async function handleGet() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const client = createAdminClient()
    const { data, error } = await client
      .from('numbering_series')
      .select('*')
      .eq('company_id', companyId)
      .order('series_key')
    if (error) throw error
    return Response.json({ series: data ?? [] })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    const series = await upsertNumberingSeries({
      seriesKey: body.seriesKey,
      prefix: body.prefix,
      suffix: body.suffix,
      padding: body.padding,
      includeFiscalYear: body.includeFiscalYear,
      branchCode: body.branchCode,
    })
    return Response.json(series, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
export const POST = guarded('platform.manage', handlePost)
