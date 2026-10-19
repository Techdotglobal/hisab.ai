import { guarded } from '@/lib/permissions/guard'
import { randomUUID } from 'node:crypto'
import { authzErrorResponse } from '@/lib/authz'
import { postIdempotentOpeningBalance } from '@/lib/accounting/opening-balances'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'

async function handlePost(request:Request){
  try{
    const user=await requireAccountingAdmin();const body=await request.json() as {date?:string;description?:string;currency?:string;idempotencyKey?:string;lines?:Array<{accountId:string;debit?:number;credit?:number;description?:string}>}
    const lines=(body.lines??[]).map(line=>({accountId:String(line.accountId),debit:Number(line.debit??0),credit:Number(line.credit??0),description:line.description}))
    const result=await postIdempotentOpeningBalance({companyId:user.companyId,userId:user.id,date:new Date(body.date??Date.now()),currency:String(body.currency??'SAR').toUpperCase(),description:body.description??'Opening balances',idempotencyKey:body.idempotencyKey??`manual:${randomUUID()}`,lines})
    return Response.json({...result,sourceId:result.journalId,journalEntry:{id:result.journalId,status:'POSTED'}},{status:result.reused?200:201})
  }catch(error){return authzErrorResponse(error)}
}

export const POST = guarded('imports.run', handlePost)
