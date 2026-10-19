import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, getCompanyRow, insertCompanyRow, listCompanyRows, updateCompanyRow } from '@/lib/api/crud'
import { getNextSequence } from '@/lib/sequences'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const rows = await listCompanyRows('expense_claims', {
      orderBy: 'date',
      filters: status ? { status } : undefined,
    })
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
    if (!body.employeeId || !body.date) {
      return Response.json({ error: 'employeeId and date are required' }, { status: 400 })
    }

    const claimNo = await getNextSequence('EXPENSE_CLAIM', 'CLM-')
    const row = await insertCompanyRow('expense_claims', {
      claim_no: claimNo,
      employee_id: body.employeeId,
      date: new Date(body.date).toISOString(),
      status: body.status ?? 'SUBMITTED',
      total: body.total ?? 0,
      notes: body.notes ?? null,
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

    const existing = await getCompanyRow('expense_claims', body.id)
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const row = await updateCompanyRow('expense_claims', body.id, {
      employee_id: body.employeeId ?? existing.employee_id,
      date: body.date ? new Date(body.date).toISOString() : existing.date,
      status: body.status ?? existing.status,
      total: body.total ?? existing.total,
      notes: body.notes ?? existing.notes,
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
    await deleteCompanyRow('expense_claims', id)
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
