import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const client = createAdminClient()

    const { data, error } = await client
      .from('bank_reconciliations')
      .select('*, bank_account:bank_accounts(name, currency, current_balance), items:bank_reconciliation_items(*, bank_transaction:bank_transactions(*))')
      .eq('id', id)
      .eq('company_id', companyId)
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
      .from('bank_reconciliations')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (findError) throw findError
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const nextStatus = body.status ?? existing.status
    if(nextStatus==='COMPLETED'){
      const transactionIds=Array.isArray(body.transactionIds)?body.transactionIds.map(String):null
      const completed=await client.rpc('complete_bank_reconciliation',{p_company_id:companyId,p_reconciliation_id:id,p_transaction_ids:transactionIds})
      if(completed.error)throw completed.error
      const result=await client.from('bank_reconciliations').select('*, bank_account:bank_accounts(name, currency, current_balance), items:bank_reconciliation_items(*, bank_transaction:bank_transactions(*))').eq('id',id).eq('company_id',companyId).single()
      if(result.error)throw result.error
      return Response.json(toCamel(result.data))
    }
    const patch: Record<string, unknown> = {}
    if (body.statementDate !== undefined) patch.statement_date = new Date(body.statementDate).toISOString()
    if (body.statementBalance !== undefined) patch.statement_balance = Number(body.statementBalance)
    if (body.reconciledBalance !== undefined) patch.reconciled_balance = Number(body.reconciledBalance)
    if (body.status !== undefined) patch.status = body.status

    const { data, error } = await client
      .from('bank_reconciliations')
      .update(patch)
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*, bank_account:bank_accounts(name, currency, current_balance)')
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

    const { error } = await client
      .from('bank_reconciliations')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) throw error
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('banking.view', handleGet)
export const PUT = guarded('banking.edit', handlePut)
export const DELETE = guarded('banking.edit', handleDelete)
