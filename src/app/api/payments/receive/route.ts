import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { postPaymentToLedger } from '@/lib/accounting/document-posting'
import { replacePaymentAllocations } from '@/lib/accounting/payment-allocations'
import { getCompanyPrimaryCurrency } from '@/lib/currency/company'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'
import { resolvePaymentMethod } from '@/lib/product-parity/payment-methods'

interface ReceivePaymentInput {invoiceId:string;amount:number;cashAmount?:number;creditAmount?:number;creditIds?:string[]}
const money=(value:number)=>Math.round(value*10_000)/10_000

async function handlePost(request:Request){
  try{
    await requireAuth();const companyId=await resolveCompanyId(),body=await request.json(),entries:ReceivePaymentInput[]=body.allocations??body.payments??[]
    if(!Array.isArray(entries)||!entries.length)return Response.json({error:'allocations array is required'},{status:400})
    const ids=entries.map(entry=>String(entry.invoiceId??''));if(ids.some(id=>!id)||new Set(ids).size!==ids.length)return Response.json({error:'Each invoice may appear exactly once in a payment.'},{status:400})
    const db=createAdminClient(),invoiceResult=await db.from('invoices').select('id,invoice_no,customer_id,currency,balance').eq('company_id',companyId).in('id',ids).is('deleted_at',null)
    if(invoiceResult.error)throw invoiceResult.error;if((invoiceResult.data?.length??0)!==ids.length)return Response.json({error:'One or more invoices were not found.'},{status:404})
    const invoices=new Map((invoiceResult.data??[]).map(invoice=>[String(invoice.id),invoice])),customerIds=new Set((invoiceResult.data??[]).map(invoice=>String(invoice.customer_id))),currencies=new Set((invoiceResult.data??[]).map(invoice=>String(invoice.currency).toUpperCase()))
    if(customerIds.size!==1)return Response.json({error:'All allocations in a customer payment must belong to the same customer.'},{status:400})
    if(currencies.size!==1)return Response.json({error:'All allocations in a payment must use the same transaction currency.'},{status:400})
    const allocations=entries.map((entry,index)=>{const invoice=invoices.get(String(entry.invoiceId))!,amount=money(Number(entry.amount)),creditAmount=money(Number(entry.creditAmount??0)),cashAmount=money(Number(entry.cashAmount??amount-creditAmount));if(!Number.isFinite(amount)||amount<=0||cashAmount<0||creditAmount<0||money(cashAmount+creditAmount)!==amount)throw new Error(`Allocation ${index+1} has invalid amounts.`);if(amount>Number(invoice.balance)+0.0001)throw new Error(`Allocation exceeds the remaining balance of invoice ${invoice.invoice_no}.`);return {invoiceId:String(invoice.id),amount,cashAmount,creditAmount,currency:String(invoice.currency),sourceSystem:'HISAB',sourceLineKey:`invoice:${invoice.id}`,localCreditIds:entry.creditIds??[]}})
    const cashApplied=money(allocations.reduce((sum,item)=>sum+item.cashAmount,0)),paymentAmount=money(Number(body.amount??cashApplied));if(!Number.isFinite(paymentAmount)||paymentAmount<cashApplied)return Response.json({error:'Payment amount cannot be less than its cash allocations.'},{status:400})
    const method=await resolvePaymentMethod(companyId,body.paymentMethodId,body.method??'BANK_TRANSFER'),paymentNo=await getNextSequence('PAYMENT','PAY-'),currency=[...currencies][0]??await getCompanyPrimaryCurrency()
    const created=await db.from('payments').insert({company_id:companyId,payment_no:paymentNo,date:new Date(body.date??Date.now()).toISOString(),currency,amount:paymentAmount,method:method.code,payment_method_id:method.id,reference:body.reference??null,notes:body.notes??null,bank_account_id:body.bankAccountId??null,customer_id:[...customerIds][0],invoice_id:ids[0]}).select('*').single()
    if(created.error)throw created.error
    await replacePaymentAllocations(companyId,String(created.data.id),allocations)
    await postPaymentToLedger(String(created.data.id),companyId)
    const result=await db.from('payments').select('*,allocations:payment_allocations(*)').eq('company_id',companyId).eq('id',created.data.id).single();if(result.error)throw result.error
    return Response.json(result.data,{status:201})
  }catch(error){if(error instanceof Error&&error.message==='Unauthorized')return Response.json({error:'Unauthorized'},{status:401});return Response.json({error:error instanceof Error?error.message:String(error)},{status:400})}
}

export const POST = guarded('payments.edit', handlePost)
