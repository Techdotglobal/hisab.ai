import { guarded } from '@/lib/permissions/guard'
import { productParityErrorResponse } from '@/lib/product-parity/api-errors'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAccountingRead, requireAccountingWrite } from '@/lib/product-parity/permissions'
import { invoiceBillableCharges, markExpenseBillable } from '@/lib/product-parity/service'

async function handleGet(request: Request) { try { const user=await requireAccountingRead(); const customerId=new URL(request.url).searchParams.get('customerId'); const db=createAdminClient(); let tq=db.from('time_activities').select('*,employee:employees(name),vendor:vendors(name),project:cost_centers(name)').eq('company_id',user.companyId).eq('is_billable',true).eq('status','APPROVED').is('deleted_at',null); let eq=db.from('expenses').select('*').eq('company_id',user.companyId).eq('is_billable',true).eq('billable_status','UNBILLED').is('deleted_at',null); if(customerId){tq=tq.eq('customer_id',customerId);eq=eq.eq('customer_id',customerId)} const [times,expenses]=await Promise.all([tq,eq]);if(times.error)throw times.error;if(expenses.error)throw expenses.error;return Response.json({timeActivities:times.data??[],expenses:expenses.data??[]}) }catch(error){return productParityErrorResponse(error)} }
async function handlePatch(request: Request){try{const user=await requireAccountingWrite();const body=await request.json();return Response.json(await markExpenseBillable(user.companyId,String(body.expenseId),body))}catch(error){return productParityErrorResponse(error)}}
async function handlePost(request: Request){try{const user=await requireAccountingWrite();return Response.json(await invoiceBillableCharges(user.companyId,user.id,await request.json()),{status:201})}catch(error){return productParityErrorResponse(error)}}

export const GET = guarded('invoices.view', handleGet)
export const POST = guarded('invoices.edit', handlePost)
export const PATCH = guarded('invoices.edit', handlePatch)
