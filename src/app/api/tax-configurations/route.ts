import { guarded } from '@/lib/permissions/guard'
import { authzErrorResponse, requireRole } from '@/lib/authz'
import { logAudit } from '@/lib/audit/log'
import { createAdminClient } from '@/lib/supabase/admin'
import { mapTaxRateRow } from '@/lib/db/entity-mappers'
import { validateTaxConfigurationInput } from '@/lib/invoices/validation'

function toApiTaxConfig(row: Record<string, unknown>) {
  const mapped = mapTaxRateRow(row)
  return {
    id: mapped.id,
    name: mapped.name,
    category: mapped.category,
    zatcaMapping: mapped.zatcaMapping,
    percentage: mapped.rate,
    type: mapped.type,
    isDefault: mapped.isDefault,
    isActive: mapped.isActive,
    createdAt: mapped.createdAt,
    updatedAt: row.updated_at ?? row.created_at,
  }
}

async function handleGet(request: Request) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'AUDITOR'])
    const companyId = user.companyId
    const includeInactive = new URL(request.url).searchParams.get('includeInactive') === 'true'
    const client = createAdminClient()
    let query = client
      .from('tax_rates')
      .select('*')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('name')
    if (!includeInactive) query = query.eq('is_active', true)

    const { data, error } = await query

    if (error) throw error
    return Response.json((data ?? []).map((row) => toApiTaxConfig(row)))
  } catch (error) {
    return authzErrorResponse(error)
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const companyId = user.companyId
    const body = await request.json()
    const name = String(body.name ?? '').trim()
    const category = String(body.category ?? body.type ?? 'VAT').trim() || 'VAT'
    const zatcaMapping = String(body.zatcaMapping ?? 'STANDARD_RATED').trim()
    const percentage = Number(body.percentage ?? body.rate ?? 0)

    const validationError = validateTaxConfigurationInput({
      name,
      percentage,
      category,
      zatcaMapping,
    })
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 })
    }

    const client = createAdminClient()
    if (body.isDefault) {
      const { error: defaultError } = await client
        .from('tax_rates')
        .update({ is_default: false })
        .eq('company_id', companyId)
        .is('deleted_at', null)
      if (defaultError) throw defaultError
    }
    const { data, error } = await client
      .from('tax_rates')
      .insert({
        company_id: companyId,
        name,
        rate: percentage,
        type: category === 'VAT' ? 'VAT' : category,
        category,
        zatca_mapping: zatcaMapping,
        is_default: Boolean(body.isDefault),
        is_active: body.isActive !== false,
      })
      .select('*')
      .single()

    if (error) throw error
    await logAudit({
      companyId,
      userId: user.id,
      action: body.duplicateOf ? 'TAX_DUPLICATED' : 'TAX_CREATED',
      entityType: 'tax_rate',
      entityId: data.id,
      details: { name, percentage, type: category, sourceTaxId: body.duplicateOf ?? null },
    })
    return Response.json(toApiTaxConfig(data), { status: 201 })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export const GET = guarded('tax.view', handleGet)
export const POST = guarded('tax.manage', handlePost)
