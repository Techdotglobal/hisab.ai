import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { listMasterRecords, createMasterRecord } from '@/lib/master-data/repository'

const VALID_TABLES = new Set(['units_of_measure', 'warehouses', 'payment_terms', 'departments', 'company_currencies'])

async function handleGet(_req: Request, { params }: { params: Promise<{ table: string }> }) {
  try {
    await requireAuth()
    const { table } = await params
    if (!VALID_TABLES.has(table)) {
      return Response.json({ error: 'Invalid master table' }, { status: 400 })
    }
    const rows = await listMasterRecords(table as 'units_of_measure')
    return Response.json(rows)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request, { params }: { params: Promise<{ table: string }> }) {
  try {
    await requireAuth()
    const { table } = await params
    if (!VALID_TABLES.has(table)) {
      return Response.json({ error: 'Invalid master table' }, { status: 400 })
    }
    const body = await request.json()
    const row = await createMasterRecord(table as 'units_of_measure', body)
    return Response.json(row, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
export const POST = guarded(['settings.manage', 'inventory.edit', 'cost_centers.manage'], handlePost)
