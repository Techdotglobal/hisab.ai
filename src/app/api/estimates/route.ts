import { requireAuth } from '@/lib/auth'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { processSalesLines } from '@/lib/sales/line-utils'
import { getNextSequence } from '@/lib/sequences'
import { fetchAllRows } from '@/lib/db/repository-utils'

function mapEstimate(row: Record<string, unknown>, customer?: { name?: string } | null) {
  return {
    id: String(row.id),
    estimateNo: String(row.estimate_no),
    customerId: String(row.customer_id),
    customer: customer ? { name: customer.name ?? '' } : undefined,
    date: row.date,
    expiryDate: row.expiry_date,
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

function mapEstimateLine(row: Record<string, unknown>) {
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
        .from('estimates')
        .select('*, customers(name)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
      if (status) query = query.eq('status', status)
      if (search) query = query.ilike('estimate_no', `%${search}%`)
      return query.order('date', { ascending: false }).order('id', { ascending: true })
    }

    const { data, error } = await fetchAllRows(buildQuery)
    if (error) throw error

    const items = (data ?? []).map((row) => {
      const customer = row.customers as { name?: string } | null
      return mapEstimate(row, customer)
    })

    return Response.json(items)
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
    const { customerId, date, expiryDate, currency, lines, notes, status } = body

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
    const estimateNo = await getNextSequence('ESTIMATE', 'EST-')
    const resolvedCurrency = await resolveTransactionCurrency(currency)

    const { data: estimate, error } = await client
      .from('estimates')
      .insert({
        company_id: companyId,
        estimate_no: estimateNo,
        customer_id: customerId,
        date: new Date(date).toISOString(),
        expiry_date: expiryDate ? new Date(expiryDate).toISOString() : null,
        status: status ?? 'DRAFT',
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
      estimate_id: estimate.id,
      account_id: line.accountId,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      tax_rate: line.taxRate,
      amount: line.amount,
    }))

    const { error: lineError } = await client.from('estimate_lines').insert(lineRows)
    if (lineError) throw lineError

    return Response.json(mapEstimate(estimate), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export { mapEstimate, mapEstimateLine }
