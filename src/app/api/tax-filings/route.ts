import { guarded } from '@/lib/permissions/guard'
import { productParityErrorResponse } from '@/lib/product-parity/api-errors'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAccountingRead, requireAccountingWrite } from '@/lib/product-parity/permissions'
import { createTaxFilingPeriod, createTaxSettlement } from '@/lib/product-parity/service'
async function handleGet(){try{const user=await requireAccountingRead();const db=createAdminClient();const [periods,settlements]=await Promise.all([db.from('tax_filing_periods').select('*,agency:tax_agencies(id,name)').eq('company_id',user.companyId).order('period_end',{ascending:false}),db.from('tax_settlements').select('*,agency:tax_agencies(id,name)').eq('company_id',user.companyId).order('date',{ascending:false})]);if(periods.error)throw periods.error;if(settlements.error)throw settlements.error;return Response.json({periods:periods.data??[],settlements:settlements.data??[]})}catch(error){return productParityErrorResponse(error)}}
async function handlePost(request:Request){try{const user=await requireAccountingWrite();const body=await request.json();return Response.json(body.action==='settle'?await createTaxSettlement(user.companyId,user.id,body):await createTaxFilingPeriod(user.companyId,body),{status:201})}catch(error){return productParityErrorResponse(error)}}

export const GET = guarded('tax.view', handleGet)
export const POST = guarded('tax.manage', handlePost)
