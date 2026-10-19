import { guarded } from '@/lib/permissions/guard'
import { authzErrorResponse } from '@/lib/authz'
import { requireAccountingRead } from '@/lib/product-parity/permissions'
import { buildProductParityReports } from '@/lib/product-parity/reports'
async function handleGet(request:Request){try{const user=await requireAccountingRead();const p=new URL(request.url).searchParams;const from=new Date(p.get('from')??`${new Date().getFullYear()}-01-01`);const to=new Date(p.get('to')??new Date());return Response.json(await buildProductParityReports(user.companyId,from,to))}catch(error){return authzErrorResponse(error)}}

export const GET = guarded('reports.view', handleGet)
