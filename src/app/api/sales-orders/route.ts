import { requireAuth } from '@/lib/auth'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { processSalesLines } from '@/lib/sales/line-utils'
import { getNextSequence } from '@/lib/sequences'
import { fetchAllRows } from '@/lib/db/repository-utils'

function mapSalesOrder(row: Record<string, unknown>, customer?: { name?: string } | null) {
  return {
    id: String(row.id),
    orderNo: String(row.order_no),
    customerId: String(row.customer_id),
    customer: customer ? { name: customer.name ?? '' } : undefined,
    estimateId: row.estimate_id ? String(row.estimate_id) : null,
    date: row.date,
    status: String(row.status),
    currency: String(row.currency ?? 'SAR'),
    subtotal: Number(row.subtotal),
    taxAmount: Number(row.tax_amount),
    total: Number(row.total),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSalesOrderLine(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    description: String(row.description),
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    taxRate: Number(row.tax_rate),
    amount: Number(row.amount),
    accountId: row.account_id ? String(row.account_id) : null,
  }
}

export async function GET(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim()
    const status = searchParams.get('status')?.trim()

    const client = createAdminClient()
    const buildQuery = () => {
      let query = client
        .from('sales_orders')
        .select('*, customers(name)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
      if (status) query = query.eq('status', status)
      if (search) query = query.ilike('order_no', `%${search}%`)
      return query.order('date', { ascending: false }).order('id', { ascending: true })
    }

    const { data, error } = await fetchAllRows(buildQuery)
    if (error) throw error

    return Response.json((data ?? []).map((row) => {
      const customer = row.customers as { name?: string } | null
      return mapSalesOrder(row, customer)
    }))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const { customerId, estimateId, date, currency, lines, notes, status } = body

    if (!customerId || !date || !lines?.length) {
      return Response.json({ error: 'customerId, date, lines are required' }, { status: 400 })
    }

    const client = createAdminClient()
    const { data: customer, error: customerError } = await client
      .from('customers')
      .select('id')
      .eq('company_id', companyId)
      .eq('id', customerId)
      .maybeSingle()
    if (customerError) throw customerError
    if (!customer) return Response.json({ error: 'Customer not found' }, { status: 400 })

    const { processedLines, subtotal, taxAmount, total } = processSalesLines(lines)
    const orderNo = await getNextSequence('SALES_ORDER', 'SO-')
    const resolvedCurrency = await resolveTransactionCurrency(currency)

    const { data: order, error } = await client
      .from('sales_orders')
      .insert({
        company_id: companyId,
        order_no: orderNo,
        customer_id: customerId,
        estimate_id: estimateId ?? null,
        date: new Date(date).toISOString(),
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

    const lineRows = processedLines.map((line) => ({
      company_id: companyId,
      sales_order_id: order.id,
      account_id: line.accountId,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      tax_rate: line.taxRate,
      amount: line.amount,
    }))

    const { error: lineError } = await client.from('sales_order_lines').insert(lineRows)
    if (lineError) throw lineError

    return Response.json(mapSalesOrder(order), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export { mapSalesOrder, mapSalesOrderLine }
