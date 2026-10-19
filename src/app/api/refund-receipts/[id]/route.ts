import { guarded } from '@/lib/permissions/guard'
import { productParityErrorResponse } from '@/lib/product-parity/api-errors'
import { requireAccountingRead, requireAccountingWrite } from '@/lib/product-parity/permissions'
import { voidRefundReceipt } from '@/lib/product-parity/service'
import { createAdminClient } from '@/lib/supabase/admin'

async function handleGet(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAccountingRead(); const { id } = await params
    const { data, error } = await createAdminClient().from('refund_receipts').select('*,customer:customers(id,name),bank_account:bank_accounts(id,name),payment_method:payment_methods(id,name),lines:refund_receipt_lines(*)').eq('company_id', user.companyId).eq('id', id).is('deleted_at', null).maybeSingle()
    if (error) throw error
    if (!data) throw new Error('Refund receipt not found.')
    return Response.json(data)
  } catch (error) { return productParityErrorResponse(error) }
}

async function handleDelete(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const user = await requireAccountingWrite(); const { id } = await params; return Response.json(await voidRefundReceipt(user.companyId, user.id, id, await request.json())) }
  catch (error) { return productParityErrorResponse(error) }
}

export const GET = guarded('invoices.view', handleGet)
export const DELETE = guarded('invoices.edit', handleDelete)
