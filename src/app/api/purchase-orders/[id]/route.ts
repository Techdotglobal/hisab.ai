import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { processPurchaseLines, toCamel } from '@/lib/api/db-transform'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const client = createAdminClient()

    const { data, error } = await client
      .from('purchase_orders')
      .select('*, vendor:vendors(*), lines:purchase_order_lines(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(toCamel(data))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const body = await request.json()
    const client = createAdminClient()

    const { data: existing, error: findError } = await client
      .from('purchase_orders')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .maybeSingle()

    if (findError) throw findError
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
    if (existing.status === 'CONVERTED') {
      return Response.json({ error: 'Converted purchase orders cannot be edited' }, { status: 400 })
    }

    const { subtotal, taxAmount, total, processed } = processPurchaseLines(body.lines ?? [])
    const resolvedCurrency = body.currency !== undefined
      ? await resolveTransactionCurrency(body.currency)
      : existing.currency

    const { data: updated, error } = await client
      .from('purchase_orders')
      .update({
        vendor_id: body.vendorId ?? existing.vendor_id,
        date: body.date ? new Date(body.date).toISOString() : existing.date,
        expected_date: body.expectedDate ? new Date(body.expectedDate).toISOString() : existing.expected_date,
        status: body.status ?? existing.status,
        currency: resolvedCurrency,
        subtotal,
        tax_amount: taxAmount,
        total,
        notes: body.notes ?? existing.notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*')
      .single()

    if (error) throw error

    if (Array.isArray(body.lines)) {
      await client.from('purchase_order_lines').delete().eq('purchase_order_id', id)
      if (processed.length > 0) {
        const { error: lineError } = await client.from('purchase_order_lines').insert(
          processed.map((line) => ({
            company_id: companyId,
            purchase_order_id: id,
            ...line,
          })),
        )
        if (lineError) throw lineError
      }
    }

    const { data: full, error: fetchError } = await client
      .from('purchase_orders')
      .select('*, vendor:vendors(name), lines:purchase_order_lines(*)')
      .eq('id', id)
      .single()

    if (fetchError) throw fetchError
    return Response.json(toCamel(full ?? updated))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const client = createAdminClient()

    const { data: existing, error: findError } = await client
      .from('purchase_orders')
      .select('status')
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .maybeSingle()

    if (findError) throw findError
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
    if (existing.status === 'CONVERTED') {
      return Response.json({ error: 'Converted purchase orders cannot be deleted' }, { status: 400 })
    }

    const { error } = await client
      .from('purchase_orders')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) throw error
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('bills.view', handleGet)
export const PUT = guarded('bills.edit', handlePut)
export const DELETE = guarded('bills.edit', handleDelete)
