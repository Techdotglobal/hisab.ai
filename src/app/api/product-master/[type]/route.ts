import { guarded } from '@/lib/permissions/guard'
import { productParityErrorResponse } from '@/lib/product-parity/api-errors'
import { requireAccountingAdmin, requireAccountingRead } from '@/lib/product-parity/permissions'
import { archiveProductMaster, createProductMaster, listProductMaster, updateProductMaster, type ProductMasterKey } from '@/lib/product-parity/master-data'
const KEYS=new Set(['customer-types','payment-methods','tax-agencies'])
async function keyOf(params:Promise<{type:string}>){const {type}=await params;if(!KEYS.has(type))throw new Error('Unknown master-data type.');return type as ProductMasterKey}
async function handleGet(_r:Request,{params}:{params:Promise<{type:string}>}){try{const user=await requireAccountingRead();return Response.json(await listProductMaster(user.companyId,await keyOf(params)))}catch(error){return productParityErrorResponse(error)}}
async function handlePost(request:Request,{params}:{params:Promise<{type:string}>}){try{const user=await requireAccountingAdmin();return Response.json(await createProductMaster(user.companyId,await keyOf(params),await request.json()),{status:201})}catch(error){return productParityErrorResponse(error)}}
async function handlePut(request:Request,{params}:{params:Promise<{type:string}>}){try{const user=await requireAccountingAdmin();const body=await request.json();return Response.json(await updateProductMaster(user.companyId,await keyOf(params),String(body.id),body))}catch(error){return productParityErrorResponse(error)}}
async function handleDelete(request:Request,{params}:{params:Promise<{type:string}>}){try{const user=await requireAccountingAdmin();const id=new URL(request.url).searchParams.get('id');if(!id)return Response.json({error:'id is required'},{status:400});await archiveProductMaster(user.companyId,await keyOf(params),id);return Response.json({success:true})}catch(error){return productParityErrorResponse(error)}}

export const GET = guarded('dashboard.view', handleGet)
export const POST = guarded('inventory.edit', handlePost)
export const PUT = guarded('inventory.edit', handlePut)
export const DELETE = guarded('inventory.edit', handleDelete)
