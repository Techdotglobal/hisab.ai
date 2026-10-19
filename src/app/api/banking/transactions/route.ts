import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { recordBankTransaction } from '@/lib/banking/transactions'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const bankAccountId = searchParams.get('bankAccountId') ?? ''
    const status = searchParams.get('status') ?? ''
    const dateFrom = searchParams.get('dateFrom')
    const dateTo = searchParams.get('dateTo')
    const client = createAdminClient()

    let query = client
      .from('bank_transactions')
      .select('*, bank_account:bank_accounts(name, currency)')
      .eq('company_id', companyId)
      .order('transaction_date', { ascending: false })

    if (bankAccountId) query = query.eq('bank_account_id', bankAccountId)
    if (status) query = query.eq('status', status)
    if (dateFrom) query = query.gte('transaction_date', new Date(dateFrom).toISOString())
    if (dateTo) query = query.lte('transaction_date', new Date(dateTo).toISOString())

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
    const {
      bankAccountId, transactionDate, description, reference,
      amount, type, status, paymentId,
    } = body

    if (!bankAccountId || !transactionDate || !description || amount === undefined) {
      return Response.json({ error: 'bankAccountId, transactionDate, description, amount are required' }, { status: 400 })
    }

    const txnType = type ?? 'DEBIT'
    const txnAmount = Math.abs(Number(amount))
    const data=await recordBankTransaction({companyId,bankAccountId,transactionDate:new Date(transactionDate),description,reference,amount:txnAmount,type:txnType,status,paymentId})
    return Response.json(toCamel(data), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('banking.view', handleGet)
export const POST = guarded('banking.edit', handlePost)
