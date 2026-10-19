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
      .from('tax_groups')
      .select('*, rates:tax_group_rates(*, tax_rate:tax_rates(id, name, rate, type, tax_mode))')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('name')

    if (error) throw error
    return Response.json(data ?? [])
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
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const name = String(body.name ?? '').trim()
    if (!name) return Response.json({ error: 'name is required' }, { status: 400 })

    const client = createAdminClient()
    const { data: group, error } = await client
      .from('tax_groups')
      .insert({
        company_id: companyId,
        name,
        description: body.description ?? null,
        compound_method: body.compoundMethod ?? 'ADDITIVE',
      })
      .select('*')
      .single()

    if (error) throw error

    const taxRateIds: string[] = Array.isArray(body.taxRateIds) ? body.taxRateIds : []
    if (taxRateIds.length > 0) {
      const rows = taxRateIds.map((taxRateId: string, index: number) => ({
        company_id: companyId,
        tax_group_id: group.id,
        tax_rate_id: taxRateId,
        sequence: index + 1,
      }))
      const { error: linkError } = await client.from('tax_group_rates').insert(rows)
      if (linkError) throw linkError
    }

    return Response.json(group, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('tax.view', handleGet)
export const POST = guarded('tax.manage', handlePost)
