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
      .from('report_schedules')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return Response.json({ schedules: data ?? [] })
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
      .from('report_schedules')
      .insert({
        company_id: companyId,
        definition_id: body.definitionId ?? null,
        report_key: body.reportKey ?? null,
        name: String(body.name ?? 'Scheduled Report'),
        frequency: body.frequency ?? 'MONTHLY',
        cron_expression: body.cronExpression ?? null,
        filters: body.filters ?? {},
        export_format: (body.exportFormat ?? 'PDF').toUpperCase(),
        email_recipients: body.emailRecipients ?? [],
        is_active: body.isActive ?? true,
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
