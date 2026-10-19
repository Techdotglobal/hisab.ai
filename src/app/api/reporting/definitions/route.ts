import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const client = createAdminClient()
    const { data, error } = await client
      .from('report_definitions')
      .select('*')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('name')
    if (error) throw error
    return Response.json({ definitions: data ?? [] })
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
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const client = createAdminClient()

    const { data, error } = await client
      .from('report_definitions')
      .insert({
        company_id: companyId,
        name: String(body.name ?? 'Custom Report'),
        description: body.description ?? null,
        base_report_key: String(body.baseReportKey ?? body.reportKey ?? 'profit-loss'),
        layout: body.layout ?? {},
        columns: body.columns ?? [],
        filters: body.filters ?? [],
        grouping: body.grouping ?? [],
        sorting: body.sorting ?? [],
        calculated_columns: body.calculatedColumns ?? [],
        is_shared: body.isShared ?? false,
        created_by_id: user.id,
      })
      .select('*')
      .single()

    if (error) throw error
    return Response.json(data, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('reports.view', handleGet)
export const POST = guarded('reports.view', handlePost)
