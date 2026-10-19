import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const activeOnly = searchParams.get('active') !== 'false'
    const client = createAdminClient()

    let query = client
      .from('bank_accounts')
      .select('*, account:chart_of_accounts(account_no, name)')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('name', { ascending: true })

    if (activeOnly) query = query.eq('is_active', true)

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
      name, accountNumber, bankName, currency, openingBalance,
      accountType, accountId, isActive,
    } = body

    if (!name) return Response.json({ error: 'name is required' }, { status: 400 })

    const resolvedCurrency = await resolveTransactionCurrency(currency)
    const balance = Number(openingBalance) || 0
    const client = createAdminClient()

    const { data, error } = await client
      .from('bank_accounts')
      .insert({
        company_id: companyId,
        name,
        account_number: accountNumber ?? null,
        bank_name: bankName ?? null,
        currency: resolvedCurrency,
        opening_balance: balance,
        current_balance: balance,
        account_type: accountType ?? 'BANK',
        account_id: accountId ?? null,
        is_active: isActive ?? true,
      })
      .select('*, account:chart_of_accounts(account_no, name)')
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
