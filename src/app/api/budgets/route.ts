import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, getCompanyRow, insertCompanyRow, listCompanyRows, updateCompanyRow } from '@/lib/api/crud'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const budgetId = searchParams.get('budgetId')

    if (budgetId) {
      const companyId = await resolveCompanyId()
      const client = createAdminClient()
      const { data, error } = await client
        .from('budget_lines')
        .select('*')
        .eq('company_id', companyId)
        .eq('budget_id', budgetId)
      if (error) throw error
      return Response.json(data ?? [])
    }

    const rows = await listCompanyRows('budgets', { orderBy: 'fiscal_year', ascending: false })
    return Response.json(rows)
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
    const body = await request.json()

    if (body.line) {
      if (!body.budgetId || !body.line.accountId) {
        return Response.json({ error: 'budgetId and line.accountId required' }, { status: 400 })
      }
      const row = await insertCompanyRow('budget_lines', {
        budget_id: body.budgetId,
        account_id: body.line.accountId,
        period_month: body.line.periodMonth ?? 1,
        amount: body.line.amount ?? 0,
      })
      return Response.json(row, { status: 201 })
    }

    if (!body.name || !body.fiscalYear) {
      return Response.json({ error: 'name and fiscalYear are required' }, { status: 400 })
    }

    const row = await insertCompanyRow('budgets', {
      name: body.name,
      fiscal_year: body.fiscalYear,
      status: body.status ?? 'DRAFT',
    })
    return Response.json(row, { status: 201 })
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
    const body = await request.json()
    if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 })

    if (body.table === 'budget_lines') {
      const existing = await getCompanyRow('budget_lines', body.id)
      if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
      const row = await updateCompanyRow('budget_lines', body.id, {
        account_id: body.accountId ?? existing.account_id,
        period_month: body.periodMonth ?? existing.period_month,
        amount: body.amount ?? existing.amount,
      })
      return Response.json(row)
    }

    const existing = await getCompanyRow('budgets', body.id)
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
    const row = await updateCompanyRow('budgets', body.id, {
      name: body.name ?? existing.name,
      fiscal_year: body.fiscalYear ?? existing.fiscal_year,
      status: body.status ?? existing.status,
    })
    return Response.json(row)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    const table = searchParams.get('table') ?? 'budgets'
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
    await deleteCompanyRow(table, id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('budgets.view', handleGet)
export const POST = guarded('budgets.manage', handlePost)
export const PUT = guarded('budgets.manage', handlePut)
export const DELETE = guarded('budgets.manage', handleDelete)
