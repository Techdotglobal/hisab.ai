import { guarded } from '@/lib/permissions/guard'
import { requireRole } from '@/lib/authz'
import { postPaymentToLedger } from '@/lib/accounting/document-posting'
import { replacePaymentAllocations } from '@/lib/accounting/payment-allocations'
import { getCompanyPrimaryCurrency } from '@/lib/currency/company'
import { resolvePaymentMethod } from '@/lib/product-parity/payment-methods'
import { getNextSequence } from '@/lib/sequences'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

interface PayBillInput {billId:string;amount:number;cashAmount?:number;creditAmount?:number;creditIds?:string[]}
const money=(value:number)=>Math.round(value*10_000)/10_000

async function handlePost(request:Request){
  try{
    await requireRole(['OWNER','ADMIN','ACCOUNTANT','MANAGER']);const companyId=await resolveCompanyId(),body=await request.json(),entries:PayBillInput[]=body.allocations??body.payments??[]
    if(!Array.isArray(entries)||!entries.length)return Response.json({error:'allocations array is required'},{status:400})
    const ids=entries.map(entry=>String(entry.billId??''));if(ids.some(id=>!id)||new Set(ids).size!==ids.length)return Response.json({error:'Each bill may appear exactly once in a payment.'},{status:400})
    const db=createAdminClient(),billResult=await db.from('bills').select('id,bill_no,vendor_id,currency,balance').eq('company_id',companyId).in('id',ids).is('deleted_at',null)
    if(billResult.error)throw billResult.error;if((billResult.data?.length??0)!==ids.length)return Response.json({error:'One or more bills were not found.'},{status:404})
    const bills=new Map((billResult.data??[]).map(bill=>[String(bill.id),bill])),vendorIds=new Set((billResult.data??[]).map(bill=>String(bill.vendor_id))),currencies=new Set((billResult.data??[]).map(bill=>String(bill.currency).toUpperCase()))
    if(vendorIds.size!==1)return Response.json({error:'All allocations in a vendor payment must belong to the same vendor.'},{status:400})
    if(currencies.size!==1)return Response.json({error:'All allocations in a payment must use the same transaction currency.'},{status:400})
    const allocations=entries.map((entry,index)=>{const bill=bills.get(String(entry.billId))!,amount=money(Number(entry.amount)),creditAmount=money(Number(entry.creditAmount??0)),cashAmount=money(Number(entry.cashAmount??amount-creditAmount));if(!Number.isFinite(amount)||amount<=0||cashAmount<0||creditAmount<0||money(cashAmount+creditAmount)!==amount)throw new Error(`Allocation ${index+1} has invalid amounts.`);if(amount>Number(bill.balance)+0.0001)throw new Error(`Allocation exceeds the remaining balance of bill ${bill.bill_no}.`);return {billId:String(bill.id),amount,cashAmount,creditAmount,currency:String(bill.currency),sourceSystem:'HISAB',sourceLineKey:`bill:${bill.id}`,localCreditIds:entry.creditIds??[]}})
    const cashApplied=money(allocations.reduce((sum,item)=>sum+item.cashAmount,0)),paymentAmount=money(Number(body.amount??cashApplied));if(!Number.isFinite(paymentAmount)||paymentAmount<cashApplied)return Response.json({error:'Payment amount cannot be less than its cash allocations.'},{status:400})
    const method=await resolvePaymentMethod(companyId,body.paymentMethodId,body.method??'BANK_TRANSFER'),paymentNo=await getNextSequence('PAYMENT','PAY-'),currency=[...currencies][0]??await getCompanyPrimaryCurrency()
    const created=await db.from('payments').insert({company_id:companyId,payment_no:paymentNo,date:new Date(body.date??Date.now()).toISOString(),currency,amount:paymentAmount,method:method.code,payment_method_id:method.id,reference:body.reference??null,notes:body.notes??null,bank_account_id:body.bankAccountId??null,vendor_id:[...vendorIds][0],bill_id:ids[0]}).select('*').single()
    if(created.error)throw created.error
    await replacePaymentAllocations(companyId,String(created.data.id),allocations)
    await postPaymentToLedger(String(created.data.id),companyId)
    const result=await db.from('payments').select('*,allocations:payment_allocations(*)').eq('company_id',companyId).eq('id',created.data.id).single();if(result.error)throw result.error
    return Response.json(result.data,{status:201})
  }catch(error){if(error instanceof Error&&error.message==='Unauthorized')return Response.json({error:'Unauthorized'},{status:401});return Response.json({error:error instanceof Error?error.message:String(error)},{status:400})}
}

export const POST = guarded('payments.edit', handlePost)
