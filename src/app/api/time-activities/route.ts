import { guarded } from '@/lib/permissions/guard'
import { productParityErrorResponse } from '@/lib/product-parity/api-errors'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAccountingRead, requireAccountingWrite } from '@/lib/product-parity/permissions'
import { createTimeActivity } from '@/lib/product-parity/service'

async function handleGet(request: Request) { try { const user = await requireAccountingRead(); const p = new URL(request.url).searchParams; let q = createAdminClient().from('time_activities').select('*,employee:employees(id,name),vendor:vendors(id,name),customer:customers(id,name),project:cost_centers(id,name),service:inventory_items(id,name)').eq('company_id',user.companyId).is('deleted_at',null).order('activity_date',{ascending:false}); if(p.get('status'))q=q.eq('status',p.get('status')!); if(p.get('customerId'))q=q.eq('customer_id',p.get('customerId')!); if(p.get('billable')==='true')q=q.eq('is_billable',true); const {data,error}=await q;if(error)throw error;return Response.json(data??[]) } catch(error){return productParityErrorResponse(error)} }
async function handlePost(request: Request) { try { const user=await requireAccountingWrite(); return Response.json(await createTimeActivity(user.companyId,user.id,await request.json()),{status:201}) } catch(error){return productParityErrorResponse(error)} }

export const GET = guarded('invoices.view', handleGet)
export const POST = guarded('invoices.edit', handlePost)
