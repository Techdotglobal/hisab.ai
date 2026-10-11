import { requireAuth } from '@/lib/auth'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { fetchAllRows } from '@/lib/db/repository-utils'
import { processSalesLines } from '@/lib/sales/line-utils'
import { getNextSequence } from '@/lib/sequences'
import { resolvePaymentMethod } from '@/lib/product-parity/payment-methods'
import { postSalesReceiptToLedger } from '@/lib/accounting/document-posting'

function mapSalesReceipt(row: Record<string, unknown>, customer?: { name?: string } | null, method?: { id?: string; name?: string; code?: string } | null) {
  return {
    id: String(row.id),
    receiptNo: String(row.receipt_no),
    customerId: row.customer_id ? String(row.customer_id) : null,
    customer: customer ? { name: customer.name ?? '' } : undefined,
    date: row.date,
    currency: String(row.currency ?? 'SAR'),
    subtotal: Number(row.subtotal),
    taxAmount: Number(row.tax_amount),
    total: Number(row.total),
    paymentMethodId: method?.id ?? row.payment_method_id ?? null,
    paymentMethod: method?.name ?? String(row.payment_method ?? 'Cash'),
    notes: row.notes,
    createdAt: row.created_at,
    depositAccountId: row.deposit_account_id ?? null,
    lines: row.lines ?? [],
  }
}

export async function GET(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')?.trim()

    const client = createAdminClient()
    const buildQuery = () => {
      let query = client
        .from('sales_receipts')
        .select('*, customers(name), payment_methods(id,name,code), lines:sales_receipt_lines(*)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
      if (search) query = query.ilike('receipt_no', `%${search}%`)
      return query.order('date', { ascending: false }).order('id', { ascending: true })
    }

    const { data, error } = await fetchAllRows(buildQuery)
    if (error) throw error

    return Response.json((data ?? []).map((row) => {
      const customer = row.customers as { name?: string } | null
      const method = row.payment_methods as { id?: string; name?: string; code?: string } | null
      return mapSalesReceipt(row, customer, method)
    }))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const { customerId, date, currency, lines, notes, paymentMethodId, depositAccountId, subtotal, taxAmount, total } = body

    if (!date) {
      return Response.json({ error: 'date is required' }, { status: 400 })
    }
    if (!depositAccountId) return Response.json({ error: 'Deposit account is required' }, { status: 400 })

    const client = createAdminClient()
    if (customerId) {
      const { data: customer, error: customerError } = await client
        .from('customers')
        .select('id')
        .eq('company_id', companyId)
        .eq('id', customerId)
        .maybeSingle()
      if (customerError) throw customerError
      if (!customer) return Response.json({ error: 'Customer not found' }, { status: 400 })
    }

    let computedSubtotal = Number(subtotal ?? 0)
    let computedTax = Number(taxAmount ?? 0)
    let computedTotal = Number(total ?? 0)

    let processedLines:ReturnType<typeof processSalesLines>['processedLines']=[]
    if (lines?.length) {
      const processed = processSalesLines(lines)
      processedLines = processed.processedLines
      computedSubtotal = processed.subtotal
      computedTax = processed.taxAmount
      computedTotal = processed.total
    } else {
      return Response.json({ error: 'At least one line is required' }, { status: 400 })
    }

    const receiptNo = await getNextSequence('SALES_RECEIPT', 'SR-')
    const resolvedCurrency = await resolveTransactionCurrency(currency)
    const method = await resolvePaymentMethod(companyId, paymentMethodId, 'CASH')
    const accountIds=[depositAccountId,...processedLines.map(line=>line.accountId).filter(Boolean)] as string[]
    const accounts=await client.from('chart_of_accounts').select('id,canonical_type').eq('company_id',companyId).in('id',accountIds).is('deleted_at',null)
    if(accounts.error)throw accounts.error
    if(new Set((accounts.data??[]).map(item=>String(item.id))).size!==new Set(accountIds).size)return Response.json({error:'A deposit or revenue account is invalid.'},{status:400})
    const accountTypes=new Map((accounts.data??[]).map(item=>[String(item.id),String(item.canonical_type)]))
    if(accountTypes.get(String(depositAccountId))!=='Asset')return Response.json({error:'Deposit account must be an asset account.'},{status:400})
    if(processedLines.some(line=>!line.accountId))return Response.json({error:'Every Sales Receipt line requires a revenue account.'},{status:400})
    if(processedLines.some(line=>accountTypes.get(String(line.accountId))!=='Income'))return Response.json({error:'Every Sales Receipt line must post to an income account.'},{status:400})
    const itemIds=processedLines.map(line=>line.inventoryItemId).filter(Boolean) as string[]
    if(itemIds.length){const items=await client.from('inventory_items').select('id').eq('company_id',companyId).in('id',itemIds).is('deleted_at',null);if(items.error)throw items.error;if(new Set((items.data??[]).map(item=>String(item.id))).size!==new Set(itemIds).size)return Response.json({error:'A Sales Receipt inventory item is invalid.'},{status:400})}

    const { data: receipt, error } = await client
      .from('sales_receipts')
      .insert({
        company_id: companyId,
        receipt_no: receiptNo,
        customer_id: customerId ?? null,
        date: new Date(date).toISOString(),
        currency: resolvedCurrency,
        subtotal: computedSubtotal,
        tax_amount: computedTax,
        total: computedTotal,
        payment_method_id: method.id,
        payment_method: method.code,
        deposit_account_id: depositAccountId,
        status: 'DRAFT',
        notes: notes ?? null,
      })
      .select('*')
      .single()

    if (error) throw error
    const lineRows=processedLines.map((line,index)=>({company_id:companyId,sales_receipt_id:receipt.id,line_no:index+1,detail_type:'SalesItemLineDetail',description:line.description,quantity:line.quantity,unit_price:line.unitPrice,tax_rate:line.taxRate,amount:line.amount,account_id:line.accountId,inventory_item_id:line.inventoryItemId,cost_center_id:line.costCenterId}))
    const inserted=await client.from('sales_receipt_lines').insert(lineRows)
    if(inserted.error){await client.from('sales_receipts').delete().eq('company_id',companyId).eq('id',receipt.id);throw inserted.error}
    await postSalesReceiptToLedger(String(receipt.id),companyId)
    const posted=await client.from('sales_receipts').update({status:'POSTED',updated_at:new Date().toISOString()}).eq('company_id',companyId).eq('id',receipt.id)
    if(posted.error)throw posted.error
    const complete=await client.from('sales_receipts').select('*, lines:sales_receipt_lines(*)').eq('company_id',companyId).eq('id',receipt.id).single()
    if(complete.error)throw complete.error
    return Response.json(mapSalesReceipt(complete.data), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
