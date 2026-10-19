import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'
import { createBankTransfer } from '@/lib/banking/transfers'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const fromAccountId = searchParams.get('fromAccountId') ?? ''
    const client = createAdminClient()

    let query = client
      .from('bank_transfers')
      .select('*')
      .eq('company_id', companyId)
      .order('date', { ascending: false })

    if (fromAccountId) query = query.eq('from_account_id', fromAccountId)

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
    const { fromAccountId, toAccountId, date, amount, reference } = body

    if (!fromAccountId || !toAccountId || !date || !amount) {
      return Response.json({ error: 'fromAccountId, toAccountId, date, amount are required' }, { status: 400 })
    }
    const transferNo = await getNextSequence('BANK_TRANSFER', 'XFER-')
    const result = await createBankTransfer({companyId,userId:user.id,transferNo,fromAccountId,toAccountId,date:new Date(date),amount:Number(amount),reference})
    return Response.json(toCamel(result), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('banking.view', handleGet)
export const POST = guarded('banking.edit', handlePost)
