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
      .from('tax_exemptions')
      .select('*')
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
    const { data, error } = await client
      .from('tax_exemptions')
      .insert({
        company_id: companyId,
        name,
        exemption_code: body.exemptionCode ?? null,
        tax_rate_id: body.taxRateId ?? null,
        customer_id: body.customerId ?? null,
        vendor_id: body.vendorId ?? null,
        region_code: body.regionCode ?? null,
        valid_from: body.validFrom ?? null,
        valid_to: body.validTo ?? null,
        is_active: body.isActive ?? true,
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

export const GET = guarded('tax.view', handleGet)
export const POST = guarded('tax.manage', handlePost)
