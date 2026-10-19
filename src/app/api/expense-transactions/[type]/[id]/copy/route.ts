import { guarded } from '@/lib/permissions/guard'
import { requireRole, authzErrorResponse } from '@/lib/authz'
import { logAudit } from '@/lib/audit/log'
import { getNextSequence } from '@/lib/sequences'
import { createAdminClient } from '@/lib/supabase/admin'

function copyRow(row: Record<string, unknown>, omit: string[]) {
  const next = { ...row }
  for (const key of omit) delete next[key]
  return next
}

async function handlePost(_request: Request, context: { params: Promise<{ type: string; id: string }> }) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const { type, id } = await context.params
    const client = createAdminClient(); const companyId = user.companyId
    if (type === 'BILL') {
      const { data: source, error } = await client.from('bills').select('*, lines:bill_lines(*)').eq('company_id', companyId).eq('id', id).is('deleted_at', null).maybeSingle(); if (error) throw error; if (!source) return Response.json({ error: 'Not found' }, { status: 404 })
      const lines = source.lines as Record<string, unknown>[] | undefined; const bill = copyRow(source as Record<string, unknown>, ['id', 'created_at', 'updated_at', 'lines'])
      const billNo = await getNextSequence('BILL', 'BILL-'); const { data: copy, error: copyError } = await client.from('bills').insert({ ...bill, bill_no: billNo, status: 'DRAFT', amount_paid: 0, balance: source.total, deleted_at: null }).select('id').single(); if (copyError) throw copyError
      if (lines?.length) { const { error: linesError } = await client.from('bill_lines').insert(lines.map((line: Record<string, unknown>) => ({ ...copyRow(line, ['id']), bill_id: copy.id }))); if (linesError) throw linesError }
      await logAudit({ companyId, userId: user.id, action: 'COPY', entityType: 'expense_transaction:BILL', entityId: id, details: { copyId: copy.id } }); return Response.json({ id: copy.id, type })
    }
    if (type === 'EXPENSE') {
      const { data: source, error } = await client.from('expenses').select('*, lines:expense_lines(*)').eq('company_id', companyId).eq('id', id).is('deleted_at', null).maybeSingle(); if (error) throw error; if (!source) return Response.json({ error: 'Not found' }, { status: 404 })
      const lines = source.lines as Record<string, unknown>[] | undefined; const expense = copyRow(source as Record<string, unknown>, ['id', 'created_at', 'updated_at', 'lines'])
      const expenseNo = await getNextSequence('EXPENSE', 'EXP-'); const { data: copy, error: copyError } = await client.from('expenses').insert({ ...expense, expense_no: expenseNo, status: 'PENDING', deleted_at: null }).select('id').single(); if (copyError) throw copyError
      if (lines?.length) { const { error: linesError } = await client.from('expense_lines').insert(lines.map((line: Record<string, unknown>) => ({ ...copyRow(line, ['id']), expense_id: copy.id }))); if (linesError) throw linesError }
      await logAudit({ companyId, userId: user.id, action: 'COPY', entityType: 'expense_transaction:EXPENSE', entityId: id, details: { copyId: copy.id } }); return Response.json({ id: copy.id, type })
    }
    if (type === 'PURCHASE_ORDER') {
      const { data: source, error } = await client.from('purchase_orders').select('*, lines:purchase_order_lines(*)').eq('company_id', companyId).eq('id', id).is('deleted_at', null).maybeSingle(); if (error) throw error; if (!source) return Response.json({ error: 'Not found' }, { status: 404 })
      const lines = source.lines as Record<string, unknown>[] | undefined; const purchaseOrder = copyRow(source as Record<string, unknown>, ['id', 'created_at', 'updated_at', 'lines'])
      const poNo = await getNextSequence('PURCHASE_ORDER', 'PO-'); const { data: copy, error: copyError } = await client.from('purchase_orders').insert({ ...purchaseOrder, po_no: poNo, status: 'OPEN', deleted_at: null }).select('id').single(); if (copyError) throw copyError
      if (lines?.length) { const { error: linesError } = await client.from('purchase_order_lines').insert(lines.map((line: Record<string, unknown>) => ({ ...copyRow(line, ['id']), purchase_order_id: copy.id }))); if (linesError) throw linesError }
      await logAudit({ companyId, userId: user.id, action: 'COPY', entityType: 'expense_transaction:PURCHASE_ORDER', entityId: id, details: { copyId: copy.id } }); return Response.json({ id: copy.id, type })
    }
    if (type === 'SUPPLIER_CREDIT') {
      const { data: source, error } = await client.from('vendor_credits').select('*').eq('company_id', companyId).eq('id', id).is('deleted_at', null).maybeSingle(); if (error) throw error; if (!source) return Response.json({ error: 'Not found' }, { status: 404 })
      const vendorCredit = copyRow(source as Record<string, unknown>, ['id', 'created_at'])
      const creditNo = await getNextSequence('VENDOR_CREDIT', 'VC-'); const { data: copy, error: copyError } = await client.from('vendor_credits').insert({ ...vendorCredit, credit_no: creditNo, status: 'OPEN', deleted_at: null }).select('id').single(); if (copyError) throw copyError
      await logAudit({ companyId, userId: user.id, action: 'COPY', entityType: 'expense_transaction:SUPPLIER_CREDIT', entityId: id, details: { copyId: copy.id } }); return Response.json({ id: copy.id, type })
    }
    return Response.json({ error: 'Copy is not available for this transaction type' }, { status: 400 })
  } catch (error) { return authzErrorResponse(error) }
}

export const POST = guarded('expenses.edit', handlePost)
