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
      .from('cheques')
      .select('*, bank_account:bank_accounts(name, currency)')
      .eq('company_id', companyId)
      .order('issue_date', { ascending: false })

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
    const { bankAccountId, chequeNo, payee, amount, issueDate, clearanceDate, status } = body

    if (!bankAccountId || !chequeNo || !payee || !amount || !issueDate) {
      return Response.json({ error: 'bankAccountId, chequeNo, payee, amount, issueDate are required' }, { status: 400 })
    }

    const client = createAdminClient()
    const { data, error } = await client
      .from('cheques')
      .insert({
        company_id: companyId,
        bank_account_id: bankAccountId,
        cheque_no: chequeNo,
        payee,
        amount: Number(amount),
        issue_date: new Date(issueDate).toISOString(),
        clearance_date: clearanceDate ? new Date(clearanceDate).toISOString() : null,
        status: status ?? 'ISSUED',
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

async function handlePut(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const { id, status, clearanceDate } = body

    if (!id) return Response.json({ error: 'id is required' }, { status: 400 })

    const client = createAdminClient()
    const patch: Record<string, unknown> = {}
    if (status !== undefined) patch.status = status
    if (clearanceDate !== undefined) patch.clearance_date = clearanceDate ? new Date(clearanceDate).toISOString() : null
    if (status === 'CLEARED' && !clearanceDate) patch.clearance_date = new Date().toISOString()

    const { data, error } = await client
      .from('cheques')
      .update(patch)
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*, bank_account:bank_accounts(name, currency)')
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

export const GET = guarded('banking.view', handleGet)
export const POST = guarded('banking.edit', handlePost)
export const PUT = guarded('banking.edit', handlePut)
