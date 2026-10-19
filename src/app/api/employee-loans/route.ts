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

    const rows = await listCompanyRows('employee_loans', {
      orderBy: 'start_date',
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
    if (!body.employeeId || !body.principal || !body.startDate) {
      return Response.json({ error: 'employeeId, principal, startDate are required' }, { status: 400 })
    }

    const principal = Number(body.principal)
    const row = await insertCompanyRow('employee_loans', {
      employee_id: body.employeeId,
      principal,
      balance: body.balance ?? principal,
      start_date: new Date(body.startDate).toISOString(),
      status: body.status ?? 'ACTIVE',
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

    const existing = await getCompanyRow('employee_loans', body.id)
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const row = await updateCompanyRow('employee_loans', body.id, {
      employee_id: body.employeeId ?? existing.employee_id,
      principal: body.principal ?? existing.principal,
      balance: body.balance ?? existing.balance,
      start_date: body.startDate ? new Date(body.startDate).toISOString() : existing.start_date,
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
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
    await deleteCompanyRow('employee_loans', id)
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
