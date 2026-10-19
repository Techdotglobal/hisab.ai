import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, getCompanyRow, insertCompanyRow, listCompanyRows, updateCompanyRow } from '@/lib/api/crud'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const employeeId = searchParams.get('employeeId')
    const from = searchParams.get('from')
    const to = searchParams.get('to')

    const rows = await listCompanyRows('attendance_records', {
      orderBy: 'date',
      ascending: false,
      filters: employeeId ? { employee_id: employeeId } : undefined,
    })

    const filtered = rows.filter((row) => {
      if (!from && !to) return true
      const d = String(row.date)
      if (from && d < from) return false
      if (to && d > to) return false
      return true
    })

    return Response.json(filtered)
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

    const row = await insertCompanyRow('attendance_records', {
      employee_id: body.employeeId,
      date: body.date,
      hours_worked: body.hoursWorked ?? 8,
      overtime_hours: body.overtimeHours ?? 0,
      status: body.status ?? 'PRESENT',
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

    const existing = await getCompanyRow('attendance_records', body.id)
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const row = await updateCompanyRow('attendance_records', body.id, {
      employee_id: body.employeeId ?? existing.employee_id,
      date: body.date ?? existing.date,
      hours_worked: body.hoursWorked ?? existing.hours_worked,
      overtime_hours: body.overtimeHours ?? existing.overtime_hours,
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
    await deleteCompanyRow('attendance_records', id)
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
