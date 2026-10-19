import { guarded } from '@/lib/permissions/guard'
import { authzErrorResponse } from '@/lib/authz'
import { requireAccountingAdmin, requireAccountingRead } from '@/lib/product-parity/permissions'
import { isQuickBooksCertificationEnabled, quickBooksCertificationDisabledResponse } from '@/lib/quickbooks-certification/feature'
import { getCertificationReports, reviewCertification, runQuickBooksCertification } from '@/lib/quickbooks-certification/service'

async function handleGet(request:Request){if(!isQuickBooksCertificationEnabled())return quickBooksCertificationDisabledResponse();try{const user=await requireAccountingRead();const runId=new URL(request.url).searchParams.get('runId')??undefined;return Response.json(await getCertificationReports(user.companyId,runId),{headers:{'Cache-Control':'no-store'}})}catch(error){return authzErrorResponse(error)}}
async function handlePost(request:Request){if(!isQuickBooksCertificationEnabled())return quickBooksCertificationDisabledResponse();try{const user=await requireAccountingAdmin();const body=await request.json();return Response.json(await runQuickBooksCertification(user.companyId,user.id,body),{status:201,headers:{'Cache-Control':'no-store'}})}catch(error){return authzErrorResponse(error)}}
async function handlePatch(request:Request){if(!isQuickBooksCertificationEnabled())return quickBooksCertificationDisabledResponse();try{const user=await requireAccountingAdmin();const body=await request.json() as {runId?:string;approvalStatus?:string};if(!body.runId||!['APPROVED','REJECTED'].includes(body.approvalStatus??''))return Response.json({error:'runId and a valid approvalStatus are required.'},{status:400});return Response.json(await reviewCertification(user.companyId,user.id,body.runId,body.approvalStatus as 'APPROVED'|'REJECTED'))}catch(error){return authzErrorResponse(error)}}

export const GET = guarded('imports.view', handleGet)
export const POST = guarded('integrations.manage', handlePost)
export const PATCH = guarded('integrations.manage', handlePatch)
