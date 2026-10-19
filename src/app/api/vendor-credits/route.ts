import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim() ?? ''
    const status = searchParams.get('status')?.trim() ?? ''

    const client = createAdminClient()
    let query = client
      .from('vendor_credits')
      .select('*, vendor:vendors(name), bill:bills(bill_no)')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('date', { ascending: false })

    if (status) query = query.eq('status', status)
    if (search) query = query.or(`credit_no.ilike.%${search}%`)

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
    await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const { vendorId, billId, date, currency, subtotal, taxAmount, total, notes, status } = body

    if (!vendorId || !date) {
      return Response.json({ error: 'vendorId and date are required' }, { status: 400 })
    }

    const resolvedSubtotal = Number(subtotal) || 0
    const resolvedTax = Number(taxAmount) || 0
    const resolvedTotal = Number(total) || resolvedSubtotal + resolvedTax
    const creditNo = await getNextSequence('VENDOR_CREDIT', 'VC-')
    const resolvedCurrency = await resolveTransactionCurrency(currency)
    const client = createAdminClient()

    const { data, error } = await client
      .from('vendor_credits')
      .insert({
        company_id: companyId,
        credit_no: creditNo,
        vendor_id: vendorId,
        bill_id: billId ?? null,
        date: new Date(date).toISOString(),
        status: status ?? 'OPEN',
        currency: resolvedCurrency,
        subtotal: resolvedSubtotal,
        tax_amount: resolvedTax,
        total: resolvedTotal,
        applied_amount: 0,
        balance: resolvedTotal,
        notes: notes ?? null,
      })
      .select('*, vendor:vendors(name), bill:bills(bill_no)')
      .single()

    if (error) throw error
    return Response.json(toCamel(data), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('bills.view', handleGet)
export const POST = guarded('bills.edit', handlePost)
