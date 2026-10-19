import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, getCompanyRow, insertCompanyRow, listCompanyRows, updateCompanyRow } from '@/lib/api/crud'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const employeeId = searchParams.get('employeeId')
    const status = searchParams.get('status')
    const filters: Record<string, unknown> = {}
    if (employeeId) filters.employee_id = employeeId
    if (status) filters.status = status

    const rows = await listCompanyRows('employee_advances', {
      orderBy: 'date',
      filters: Object.keys(filters).length ? filters : undefined,
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
    if (!body.employeeId || !body.amount || !body.date) {
      return Response.json({ error: 'employeeId, amount, date are required' }, { status: 400 })
    }

    const amount = Number(body.amount)
    const row = await insertCompanyRow('employee_advances', {
      employee_id: body.employeeId,
      amount,
      balance: body.balance ?? amount,
      date: new Date(body.date).toISOString(),
      status: body.status ?? 'OPEN',
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

    const existing = await getCompanyRow('employee_advances', body.id)
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const row = await updateCompanyRow('employee_advances', body.id, {
      employee_id: body.employeeId ?? existing.employee_id,
      amount: body.amount ?? existing.amount,
      balance: body.balance ?? existing.balance,
      date: body.date ? new Date(body.date).toISOString() : existing.date,
      status: body.status ?? existing.status,
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
    await deleteCompanyRow('employee_advances', id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('employees.view', handleGet)
export const POST = guarded('employees.manage', handlePost)
export const PUT = guarded('employees.manage', handlePut)
export const DELETE = guarded('employees.manage', handleDelete)
