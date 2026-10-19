import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
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
      .from('vendor_credits')
      .select('*, vendor:vendors(*), bill:bills(*), lines:vendor_credit_lines(*, account:chart_of_accounts(account_no,name), item:inventory_items(item_code,name)), applications:vendor_credit_applications(*, bill:bills(bill_no), payment:payments(payment_no))')
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
      .from('vendor_credits')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .maybeSingle()

    if (findError) throw findError
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
    const posted=await client.from('ledger_entries').select('id').eq('company_id',companyId).eq('source_type','SUPPLIER_CREDIT').eq('source_id',id).limit(1)
    if(posted.error)throw posted.error
    if(posted.data?.length)return Response.json({error:'Posted Vendor Credits are immutable. Reverse the document instead of editing it.'},{status:409})

    const resolvedCurrency = body.currency !== undefined
      ? await resolveTransactionCurrency(body.currency)
      : existing.currency

    const subtotal = body.subtotal !== undefined ? Number(body.subtotal) : Number(existing.subtotal)
    const taxAmount = body.taxAmount !== undefined ? Number(body.taxAmount) : Number(existing.tax_amount)
    const total = body.total !== undefined ? Number(body.total) : subtotal + taxAmount
    const appliedAmount=Number(existing.applied_amount??0)
    if(total<appliedAmount)return Response.json({error:'Total cannot be lower than the amount already applied to Bills.'},{status:400})

    const { data, error } = await client
      .from('vendor_credits')
      .update({
        vendor_id: body.vendorId ?? existing.vendor_id,
        bill_id: body.billId !== undefined ? (body.billId || null) : existing.bill_id,
        date: body.date ? new Date(body.date).toISOString() : existing.date,
        status: body.status ?? existing.status,
        currency: resolvedCurrency,
        subtotal,
        tax_amount: taxAmount,
        total,
        balance: total-appliedAmount,
        notes: body.notes ?? existing.notes,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*, vendor:vendors(name), bill:bills(bill_no)')
      .single()

    if (error) throw error
    return Response.json(toCamel(data))
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
    const posted=await client.from('ledger_entries').select('id').eq('company_id',companyId).eq('source_type','SUPPLIER_CREDIT').eq('source_id',id).limit(1)
    if(posted.error)throw posted.error
    if(posted.data?.length)return Response.json({error:'Posted Vendor Credits are immutable. Reverse the document instead of deleting it.'},{status:409})

    const { error } = await client
      .from('vendor_credits')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
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

export const GET = guarded('bills.view', handleGet)
export const PUT = guarded('bills.edit', handlePut)
export const DELETE = guarded('bills.edit', handleDelete)
