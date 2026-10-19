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

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'AUDITOR'])
    const companyId = user.companyId
    const { id } = await params
    const client = createAdminClient()
    const { data, error } = await client
      .from('tax_rates')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(toApiTaxConfig(data))
  } catch (error) {
    return authzErrorResponse(error)
  }
}

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const companyId = user.companyId
    const { id } = await params
    const body = await request.json()

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = String(body.name).trim()
    if (body.category !== undefined) patch.category = String(body.category).trim()
    if (body.zatcaMapping !== undefined) patch.zatca_mapping = String(body.zatcaMapping).trim()
    if (body.percentage !== undefined || body.rate !== undefined) {
      patch.rate = Number(body.percentage ?? body.rate)
    }
    if (body.isDefault !== undefined) patch.is_default = Boolean(body.isDefault)
    if (body.isActive !== undefined) patch.is_active = Boolean(body.isActive)

    const validationError = validateTaxConfigurationInput({
      name: (patch.name as string) ?? 'Tax',
      percentage: (patch.rate as number) ?? 0,
      category: patch.category as string | undefined,
      zatcaMapping: patch.zatca_mapping as string | undefined,
    })
    if (body.name !== undefined || body.percentage !== undefined || body.rate !== undefined) {
      if (validationError && (body.name !== undefined || body.percentage !== undefined || body.rate !== undefined)) {
        // Re-validate only fields being set
        if (body.percentage !== undefined || body.rate !== undefined) {
          const pct = Number(body.percentage ?? body.rate)
          if (pct < 0 || pct > 100) {
            return Response.json({ error: 'Tax percentage must be between 0 and 100' }, { status: 400 })
          }
        }
        if (body.name !== undefined && !String(body.name).trim()) {
          return Response.json({ error: 'name is required' }, { status: 400 })
        }
        if (body.zatcaMapping !== undefined) {
          const valid = ['STANDARD_RATED', 'ZERO_RATED', 'EXEMPT', 'OUTSIDE_SCOPE']
          if (!valid.includes(String(body.zatcaMapping))) {
            return Response.json({ error: 'Invalid zatcaMapping' }, { status: 400 })
          }
        }
      }
    }

    const client = createAdminClient()
    if (patch.is_default) {
      const { error: defaultError } = await client
        .from('tax_rates')
        .update({ is_default: false })
        .eq('company_id', companyId)
        .neq('id', id)
        .is('deleted_at', null)
      if (defaultError) throw defaultError
    }
    const { data, error } = await client
      .from('tax_rates')
      .update(patch)
      .eq('company_id', companyId)
      .eq('id', id)
      .is('deleted_at', null)
      .select('*')
      .maybeSingle()

    if (error) throw error
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    await logAudit({
      companyId,
      userId: user.id,
      action: body.isActive !== undefined ? (body.isActive ? 'TAX_ACTIVATED' : 'TAX_DEACTIVATED') : 'TAX_UPDATED',
      entityType: 'tax_rate',
      entityId: id,
      details: { name: data.name },
    })
    return Response.json(toApiTaxConfig(data))
  } catch (error) {
    return authzErrorResponse(error)
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const companyId = user.companyId
    const { id } = await params
    const client = createAdminClient()
    const [{ count: invoiceLineCount, error: invoiceLineError }, { count: taxGroupCount, error: taxGroupError }, { count: exemptionCount, error: exemptionError }] = await Promise.all([
      client.from('invoice_lines').select('id', { count: 'exact', head: true }).eq('tax_rate_id', id),
      client.from('tax_group_rates').select('id', { count: 'exact', head: true }).eq('tax_rate_id', id),
      client.from('tax_exemptions').select('id', { count: 'exact', head: true }).eq('tax_rate_id', id),
    ])
    if (invoiceLineError) throw invoiceLineError
    if (taxGroupError) throw taxGroupError
    if (exemptionError) throw exemptionError
    if ((invoiceLineCount ?? 0) + (taxGroupCount ?? 0) + (exemptionCount ?? 0) > 0) {
      return Response.json({ error: 'This tax is in use and cannot be deleted. Deactivate it instead.' }, { status: 400 })
    }
    const { data, error } = await client
      .from('tax_rates')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('company_id', companyId)
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()

    if (error) throw error
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    await logAudit({ companyId, userId: user.id, action: 'TAX_DELETED', entityType: 'tax_rate', entityId: id })
    return Response.json({ success: true })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export const GET = guarded('tax.view', handleGet)
export const PUT = guarded('tax.manage', handlePut)
export const DELETE = guarded('tax.manage', handleDelete)
