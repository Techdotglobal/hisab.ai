import { guarded } from '@/lib/permissions/guard'
import { requireRole, authzErrorResponse } from '@/lib/authz'
import { logAudit } from '@/lib/audit/log'
import { createAdminClient } from '@/lib/supabase/admin'

const TABLES: Record<string, string> = { BILL: 'bills', EXPENSE: 'expenses', PURCHASE_ORDER: 'purchase_orders', SUPPLIER_CREDIT: 'vendor_credits', CHEQUE: 'cheques' }

async function handleDelete(_request: Request, context: { params: Promise<{ type: string; id: string }> }) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const { type, id } = await context.params
    const table = TABLES[type]
    if (!table) return Response.json({ error: 'Unsupported transaction type' }, { status: 400 })
    const client = createAdminClient()
    const { data, error } = await client.from(table).update({ deleted_at: new Date().toISOString() }).eq('company_id', user.companyId).eq('id', id).is('deleted_at', null).select('id').maybeSingle()
    if (error) throw error
    if (!data) return Response.json({ error: 'Not found' }, { status: 404 })
    await logAudit({ companyId: user.companyId, userId: user.id, action: 'DELETE', entityType: `expense_transaction:${type}`, entityId: id })
    return Response.json({ success: true })
  } catch (error) { return authzErrorResponse(error) }
}

export const DELETE = guarded('expenses.edit', handleDelete)
