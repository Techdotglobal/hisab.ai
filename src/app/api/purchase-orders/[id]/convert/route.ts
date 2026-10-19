import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
import { postBillToLedger } from '@/lib/accounting/document-posting'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'

async function handlePost(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const client = createAdminClient()

    const { data: po, error: poError } = await client
      .from('purchase_orders')
      .select('*, lines:purchase_order_lines(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .maybeSingle()

    if (poError) throw poError
    if (!po) return Response.json({ error: 'Purchase order not found' }, { status: 404 })
    if (po.status === 'CONVERTED') {
      return Response.json({ error: 'Purchase order already converted' }, { status: 400 })
    }
    if (po.status === 'CANCELLED') {
      return Response.json({ error: 'Cancelled purchase orders cannot be converted' }, { status: 400 })
    }

    const billNo = await getNextSequence('BILL', 'BILL-')
    const dueDate = po.expected_date ?? po.date

    const { data: bill, error: billError } = await client
      .from('bills')
      .insert({
        company_id: companyId,
        bill_no: billNo,
        vendor_id: po.vendor_id,
        purchase_order_id: po.id,
        date: new Date().toISOString(),
        due_date: dueDate,
        status: 'RECEIVED',
        approval_status: 'APPROVED',
        subtotal: po.subtotal,
        tax_amount: po.tax_amount,
        total: po.total,
        amount_paid: 0,
        balance: po.total,
        notes: po.notes,
        reference: po.po_no,
        created_by_id: user.id,
        currency: po.currency,
      })
      .select('*')
      .single()

    if (billError) throw billError

    const lines = (po.lines ?? []) as Array<Record<string, unknown>>
    if (lines.length > 0) {
      const { error: lineError } = await client.from('bill_lines').insert(
        lines.map((line) => ({
          company_id: companyId,
          bill_id: bill.id,
          account_id: line.account_id ?? null,
          description: line.description,
          quantity: line.quantity,
          unit_price: line.unit_price,
          tax_rate: line.tax_rate,
          amount: line.amount,
        })),
      )
      if (lineError) throw lineError
    }

    const { error: poUpdateError } = await client
      .from('purchase_orders')
      .update({ status: 'CONVERTED', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)

    if (poUpdateError) throw poUpdateError

    await postBillToLedger(bill.id, companyId)

    const { data: fullBill, error: fetchError } = await client
      .from('bills')
      .select('*, vendor:vendors(name), lines:bill_lines(*)')
      .eq('id', bill.id)
      .single()

    if (fetchError) throw fetchError
    return Response.json(toCamel(fullBill), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('bills.edit', handlePost)
