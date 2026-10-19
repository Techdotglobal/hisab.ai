import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { processSalesLines } from '@/lib/sales/line-utils'
import { mapEstimate, mapEstimateLine } from '../route'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const client = createAdminClient()

    const { data: row, error } = await client
      .from('estimates')
      .select('*, customers(name)')
      .eq('company_id', companyId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    const { data: lines, error: lineError } = await client
      .from('estimate_lines')
      .select('*')
      .eq('company_id', companyId)
      .eq('estimate_id', id)

    if (lineError) throw lineError

    const customer = row.customers as { name?: string } | null
    return Response.json({
      ...mapEstimate(row, customer),
      lines: (lines ?? []).map(mapEstimateLine),
    })
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

    const { data: existing, error: existingError } = await client
      .from('estimates')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()

    if (existingError) throw existingError
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
    if (existing.status === 'CONVERTED') {
      return Response.json({ error: 'Cannot edit converted estimate' }, { status: 400 })
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.customerId !== undefined) {
      const { data: customer } = await client
        .from('customers')
        .select('id')
        .eq('company_id', companyId)
        .eq('id', body.customerId)
        .maybeSingle()
      if (!customer) return Response.json({ error: 'Customer not found' }, { status: 400 })
      patch.customer_id = body.customerId
    }
    if (body.date !== undefined) patch.date = new Date(body.date).toISOString()
    if (body.expiryDate !== undefined) {
      patch.expiry_date = body.expiryDate ? new Date(body.expiryDate).toISOString() : null
    }
    if (body.status !== undefined) patch.status = body.status
    if (body.notes !== undefined) patch.notes = body.notes
    if (body.currency !== undefined) patch.currency = await resolveTransactionCurrency(body.currency)

    if (body.lines !== undefined) {
      const { processedLines, subtotal, taxAmount, total } = processSalesLines(body.lines)
      patch.subtotal = subtotal
      patch.tax_amount = taxAmount
      patch.total = total

      await client.from('estimate_lines').delete().eq('company_id', companyId).eq('estimate_id', id)
      if (processedLines.length > 0) {
        const lineRows = processedLines.map((line) => ({
          company_id: companyId,
          estimate_id: id,
          account_id: line.accountId,
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unitPrice,
          tax_rate: line.taxRate,
          amount: line.amount,
        }))
        const { error: lineError } = await client.from('estimate_lines').insert(lineRows)
        if (lineError) throw lineError
      }
    }

    const { data: updated, error } = await client
      .from('estimates')
      .update(patch)
      .eq('company_id', companyId)
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw error
    return Response.json(mapEstimate(updated))
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

    const { error } = await client
      .from('estimates')
      .update({ deleted_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', id)
      .is('deleted_at', null)

    if (error) throw error
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
export const PUT = guarded('invoices.edit', handlePut)
export const DELETE = guarded('invoices.edit', handleDelete)
