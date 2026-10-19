import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, getCompanyRow, insertCompanyRow, listCompanyRows, updateCompanyRow } from '@/lib/api/crud'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const structureId = searchParams.get('structureId')
    if (structureId) {
      const companyId = await resolveCompanyId()
      const client = createAdminClient()
      const { data, error } = await client
        .from('salary_components')
        .select('*')
        .eq('company_id', companyId)
        .eq('structure_id', structureId)
      if (error) throw error
      return Response.json(data ?? [])
    }

    const rows = await listCompanyRows('salary_structures', { orderBy: 'name', ascending: true })
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

    if (body.component) {
      if (!body.structureId || !body.component.name) {
        return Response.json({ error: 'structureId and component.name required' }, { status: 400 })
      }
      const row = await insertCompanyRow('salary_components', {
        structure_id: body.structureId,
        name: body.component.name,
        type: body.component.type ?? 'EARNING',
        amount: body.component.amount ?? 0,
        is_percentage: body.component.isPercentage ?? false,
      })
      return Response.json(row, { status: 201 })
    }

    if (!body.name) return Response.json({ error: 'name is required' }, { status: 400 })
    const row = await insertCompanyRow('salary_structures', {
      name: body.name,
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

    if (body.table === 'salary_components') {
      const existing = await getCompanyRow('salary_components', body.id)
      if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
      const row = await updateCompanyRow('salary_components', body.id, {
        name: body.name ?? existing.name,
        type: body.type ?? existing.type,
        amount: body.amount ?? existing.amount,
        is_percentage: body.isPercentage ?? existing.is_percentage,
      })
      return Response.json(row)
    }

    const existing = await getCompanyRow('salary_structures', body.id)
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
    const row = await updateCompanyRow('salary_structures', body.id, {
      name: body.name ?? existing.name,
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
    const table = searchParams.get('table') ?? 'salary_structures'
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

export const GET = guarded('payroll.view', handleGet)
export const POST = guarded('payroll.manage', handlePost)
export const PUT = guarded('payroll.manage', handlePut)
export const DELETE = guarded('payroll.manage', handleDelete)
