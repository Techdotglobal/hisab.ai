import { guarded } from '@/lib/permissions/guard'
import { authzErrorResponse } from '@/lib/authz'
import { requireAccountingAdmin,requireAccountingRead } from '@/lib/product-parity/permissions'
import { getCutoffReconciliations,runCutoffReconciliation } from '@/lib/quickbooks-cutoff/service'

async function handleGet(request:Request){try{const user=await requireAccountingRead();const id=new URL(request.url).searchParams.get('id')??undefined;return Response.json(await getCutoffReconciliations(user.companyId,id),{headers:{'Cache-Control':'no-store'}})}catch(error){return authzErrorResponse(error)}}
async function handlePost(request:Request){try{const user=await requireAccountingAdmin();return Response.json(await runCutoffReconciliation(user.companyId,user.id,await request.json()),{status:201,headers:{'Cache-Control':'no-store'}})}catch(error){return authzErrorResponse(error)}}

export const GET = guarded('imports.view', handleGet)
export const POST = guarded('imports.run', handlePost)
