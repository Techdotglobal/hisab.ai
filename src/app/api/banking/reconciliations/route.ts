import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const bankAccountId = searchParams.get('bankAccountId') ?? ''
    const status = searchParams.get('status') ?? ''
    const client = createAdminClient()

    let query = client
      .from('bank_reconciliations')
      .select('*, bank_account:bank_accounts(name, currency)')
      .eq('company_id', companyId)
      .order('statement_date', { ascending: false })

    if (bankAccountId) query = query.eq('bank_account_id', bankAccountId)
    if (status) query = query.eq('status', status)

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
    const { bankAccountId, statementDate, statementBalance, reconciledBalance, status } = body

    if (!bankAccountId || !statementDate || statementBalance === undefined) {
      return Response.json({ error: 'bankAccountId, statementDate, statementBalance are required' }, { status: 400 })
    }

    const client = createAdminClient()
    const { data, error } = await client
      .from('bank_reconciliations')
      .insert({
        company_id: companyId,
        bank_account_id: bankAccountId,
        statement_date: new Date(statementDate).toISOString(),
        statement_balance: Number(statementBalance),
        reconciled_balance: Number(reconciledBalance) || 0,
        status: status ?? 'IN_PROGRESS',
      })
      .select('*, bank_account:bank_accounts(name, currency)')
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

export const GET = guarded('banking.view', handleGet)
export const POST = guarded('banking.edit', handlePost)
