import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { processPurchaseLines, toCamel } from '@/lib/api/db-transform'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'
import { maybeStartWorkflow } from '@/lib/workflow/integration'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim() ?? ''
    const status = searchParams.get('status')?.trim() ?? ''

    const client = createAdminClient()
    let query = client
      .from('purchase_orders')
      .select('*, vendor:vendors(name), lines:purchase_order_lines(*)')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('date', { ascending: false })

    if (status) query = query.eq('status', status)
    if (search) query = query.ilike('po_no', `%${search}%`)

    const { data, error } = await query
    if (error) throw error

    return Response.json(toCamel(data ?? []))
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
    const { vendorId, date, expectedDate, currency, lines, notes, status } = body

    if (!vendorId || !date || !lines?.length) {
      return Response.json({ error: 'vendorId, date, lines are required' }, { status: 400 })
    }

    const { subtotal, taxAmount, total, processed } = processPurchaseLines(lines)
    const poNo = await getNextSequence('PURCHASE_ORDER', 'PO-')
    const resolvedCurrency = await resolveTransactionCurrency(currency)
    const client = createAdminClient()

    const { data: po, error } = await client
      .from('purchase_orders')
      .insert({
        company_id: companyId,
        po_no: poNo,
        vendor_id: vendorId,
        date: new Date(date).toISOString(),
        expected_date: expectedDate ? new Date(expectedDate).toISOString() : null,
        status: status ?? 'OPEN',
        currency: resolvedCurrency,
        subtotal,
        tax_amount: taxAmount,
        total,
        notes: notes ?? null,
      })
      .select('*')
      .single()

    if (error) throw error

    const lineRows = processed.map((line) => ({
      company_id: companyId,
      purchase_order_id: po.id,
      ...line,
    }))

    const { error: lineError } = await client.from('purchase_order_lines').insert(lineRows)
    if (lineError) throw lineError

    const { data: full, error: fetchError } = await client
      .from('purchase_orders')
      .select('*, vendor:vendors(name), lines:purchase_order_lines(*)')
      .eq('id', po.id)
      .single()

    if (fetchError) throw fetchError

    await maybeStartWorkflow({
      entityType: 'PURCHASE_ORDER',
      entityId: po.id,
      entityLabel: poNo,
      amount: total,
      submittedById: user.id,
      companyId,
    })

    return Response.json(toCamel(full), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('bills.view', handleGet)
export const POST = guarded('bills.edit', handlePost)
