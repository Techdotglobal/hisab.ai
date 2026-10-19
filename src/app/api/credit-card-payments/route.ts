import { guarded } from '@/lib/permissions/guard'
import { productParityErrorResponse } from '@/lib/product-parity/api-errors'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAccountingRead, requireAccountingWrite } from '@/lib/product-parity/permissions'
import { createCreditCardPayment, reconcileCreditCardPayment } from '@/lib/product-parity/service'

async function handleGet(){try{const user=await requireAccountingRead();const {data,error}=await createAdminClient().from('credit_card_payments').select('*,bank_account:bank_accounts!credit_card_payments_bank_account_id_fkey(id,name),credit_card_account:bank_accounts!credit_card_payments_credit_card_account_id_fkey(id,name),payment_method:payment_methods(id,name)').eq('company_id',user.companyId).is('deleted_at',null).order('date',{ascending:false});if(error)throw error;return Response.json(data??[])}catch(error){return productParityErrorResponse(error)}}
async function handlePost(request:Request){try{const user=await requireAccountingWrite();return Response.json(await createCreditCardPayment(user.companyId,user.id,await request.json()),{status:201})}catch(error){return productParityErrorResponse(error)}}
async function handlePatch(request:Request){try{const user=await requireAccountingWrite();const body=await request.json();return Response.json(await reconcileCreditCardPayment(user.companyId,String(body.id)))}catch(error){return productParityErrorResponse(error)}}

export const GET = guarded('payments.view', handleGet)
export const POST = guarded('payments.edit', handlePost)
export const PATCH = guarded('payments.edit', handlePatch)
