import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { updateMasterRecord, deleteMasterRecord } from '@/lib/master-data/repository'

const VALID_TABLES = new Set(['units_of_measure', 'warehouses', 'payment_terms', 'departments', 'company_currencies'])

async function handlePut(request: Request, { params }: { params: Promise<{ table: string; id: string }> }) {
  try {
    await requireAuth()
    const { table, id } = await params
    if (!VALID_TABLES.has(table)) {
      return Response.json({ error: 'Invalid master table' }, { status: 400 })
    }
    const body = await request.json()
    const row = await updateMasterRecord(table as 'units_of_measure', id, body)
    return Response.json(row)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ table: string; id: string }> }) {
  try {
    await requireAuth()
    const { table, id } = await params
    if (!VALID_TABLES.has(table)) {
      return Response.json({ error: 'Invalid master table' }, { status: 400 })
    }
    await deleteMasterRecord(table as 'units_of_measure', id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const PUT = guarded(['settings.manage', 'inventory.edit', 'cost_centers.manage'], handlePut)
export const DELETE = guarded(['settings.manage', 'inventory.edit', 'cost_centers.manage'], handleDelete)
