import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, getCompanyRow, insertCompanyRow, listCompanyRows, updateCompanyRow } from '@/lib/api/crud'

async function handleGet() {
  try {
    await requireAuth()
    const rows = await listCompanyRows('expense_categories', { orderBy: 'name', ascending: true })
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
    if (!body.name) return Response.json({ error: 'name is required' }, { status: 400 })

    const row = await insertCompanyRow('expense_categories', {
      name: body.name,
      account_id: body.accountId || null,
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

    const row = await updateCompanyRow('expense_categories', body.id, {
      name: body.name,
      account_id: body.accountId,
      is_active: body.isActive,
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
    await deleteCompanyRow('expense_categories', id)
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
