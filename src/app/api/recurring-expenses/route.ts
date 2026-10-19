import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, getCompanyRow, insertCompanyRow, listCompanyRows, updateCompanyRow } from '@/lib/api/crud'

async function handleGet() {
  try {
    await requireAuth()
    const rows = await listCompanyRows('recurring_expenses', { orderBy: 'next_run_date', ascending: true })
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
    if (!body.name || !body.amount || !body.nextRunDate) {
      return Response.json({ error: 'name, amount, nextRunDate are required' }, { status: 400 })
    }

    const row = await insertCompanyRow('recurring_expenses', {
      name: body.name,
      category_id: body.categoryId || null,
      amount: body.amount,
      frequency: body.frequency ?? 'MONTHLY',
      next_run_date: new Date(body.nextRunDate).toISOString(),
      is_active: body.isActive ?? true,
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

    const existing = await getCompanyRow('recurring_expenses', body.id)
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const row = await updateCompanyRow('recurring_expenses', body.id, {
      name: body.name ?? existing.name,
      category_id: body.categoryId ?? existing.category_id,
      amount: body.amount ?? existing.amount,
      frequency: body.frequency ?? existing.frequency,
      next_run_date: body.nextRunDate ? new Date(body.nextRunDate).toISOString() : existing.next_run_date,
      is_active: body.isActive ?? existing.is_active,
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
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
    await deleteCompanyRow('recurring_expenses', id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('expenses.view', handleGet)
export const POST = guarded('expenses.edit', handlePost)
export const PUT = guarded('expenses.edit', handlePut)
export const DELETE = guarded('expenses.edit', handleDelete)
