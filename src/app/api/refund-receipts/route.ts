import { guarded } from '@/lib/permissions/guard'
import { productParityErrorResponse } from '@/lib/product-parity/api-errors'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAccountingRead, requireAccountingWrite } from '@/lib/product-parity/permissions'
import { createRefundReceipt } from '@/lib/product-parity/service'

async function handleGet(request: Request) {
  try {
    const user = await requireAccountingRead(); const p = new URL(request.url).searchParams
    let query = createAdminClient().from('refund_receipts').select('*,customer:customers(id,name),bank_account:bank_accounts(id,name),payment_method:payment_methods(id,name),lines:refund_receipt_lines(*)').eq('company_id', user.companyId).is('deleted_at', null).order('date', { ascending: false })
    if (p.get('customerId')) query = query.eq('customer_id', p.get('customerId')!)
    if (p.get('from')) query = query.gte('date', p.get('from')!)
    if (p.get('to')) query = query.lte('date', `${p.get('to')}T23:59:59.999Z`)
    const { data, error } = await query; if (error) throw error; return Response.json(data ?? [])
  } catch (error) { return productParityErrorResponse(error) }
}

async function handlePost(request: Request) {
  try { const user = await requireAccountingWrite(); return Response.json(await createRefundReceipt(user.companyId, user.id, await request.json()), { status: 201 }) }
  catch (error) { return productParityErrorResponse(error) }
}

export const GET = guarded('invoices.view', handleGet)
export const POST = guarded('invoices.edit', handlePost)
