import 'server-only'
import { createHash } from 'node:crypto'
/* Transaction line payloads are intentionally provider-shaped and normalized at runtime. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAdminClient } from '@/lib/supabase/admin'
import type { DuplicateMatch, MappedRow, ModuleDefinition } from '../../types'
import type { FieldDefinition } from '../../types'
import { parseNumberField, parseOptionalString } from '../../parse-helpers'
import { getQuickBooksMaterializationStatus, hasPostedLedger, markQuickBooksMaterializationConflict, materializeQuickBooksAccounting } from '../../quickbooks/accounting-materializer'
import { resolveQuickBooksCustomerContext, resolveQuickBooksInventoryItemId, resolveQuickBooksLocalId } from '../../quickbooks/migration-store'
import { getInvoiceRepository } from '@/lib/db/provider'
import { replacePaymentAllocations,resolveQuickBooksPaymentAllocations } from '@/lib/accounting/payment-allocations'
import type { QuickBooksPaymentAllocation } from '../../quickbooks/payment-relationships'

const fields: FieldDefinition[] = [
  { key: 'sourceId', label: 'QuickBooks ID', type: 'string' },
  { key: 'transactionNo', label: 'Transaction Number', type: 'string', required: true },
  { key: 'date', label: 'Date', type: 'date', required: true },
  { key: 'dueDate', label: 'Due Date', type: 'date' },
  { key: 'expiryDate', label: 'Expiry Date', type: 'date' },
  { key: 'expectedDate', label: 'Expected Date', type: 'date' },
  { key: 'customerName', label: 'Customer', type: 'string' },
  { key: 'customerSourceId', label: 'Customer QuickBooks ID', type: 'string' },
  { key: 'vendorName', label: 'Vendor', type: 'string' },
  { key: 'vendorSourceId', label: 'Vendor QuickBooks ID', type: 'string' },
  { key: 'amount', label: 'Amount', type: 'currency' },
  { key: 'subtotal', label: 'Subtotal', type: 'currency' },
  { key: 'taxAmount', label: 'Tax Amount', type: 'currency' },
  { key: 'total', label: 'Total', type: 'currency' },
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'currency', label: 'Currency', type: 'string' },
  { key: 'exchangeRate', label: 'Exchange Rate', type: 'number' },
  { key: 'homeTotal', label: 'Home Currency Total', type: 'currency' },
  { key: 'reference', label: 'Reference', type: 'string' },
  { key: 'description', label: 'Description', type: 'string' },
  { key: 'category', label: 'Category', type: 'string' },
  { key: 'paymentMethod', label: 'Payment Method', type: 'string' },
  { key: 'paymentMethodSourceId', label: 'Payment Method QuickBooks ID', type: 'string' },
  { key: 'depositAccountSourceId', label: 'Deposit Account QuickBooks ID', type: 'string' },
  { key: 'apAccountSourceId', label: 'A/P Account QuickBooks ID', type: 'string' },
  { key: 'invoiceNo', label: 'Invoice Number', type: 'string' },
  { key: 'billNo', label: 'Bill Number', type: 'string' },
  { key: 'relatedSourceId', label: 'Related QuickBooks ID', type: 'string' },
  { key: 'allocations', label: 'Payment Allocations', type: 'string' },
  { key: 'unappliedAmount', label: 'Unapplied Amount', type: 'currency' },
  { key: 'relationshipIssues', label: 'Relationship Validation Issues', type: 'string' },
  { key: 'lines', label: 'Line Items', type: 'string' },
]

type Kind = 'invoice'|'bill'|'expense'|'journal'|'salesReceipt'|'purchaseOrder'|'vendorCredit'|'estimate'|'customerPayment'|'vendorPayment'
type Config = { key: string; displayName: string; table: string; numberColumn: string; kind: Kind; lineTable?: string; lineForeignKey?: string; party?: 'customer'|'vendor'; legacy?: boolean; createdBy?: boolean }

const configs: Config[] = [
  { key:'invoices', displayName:'Invoices', table:'invoices', numberColumn:'invoice_no', kind:'invoice', lineTable:'invoice_lines', lineForeignKey:'invoice_id', party:'customer', legacy:true, createdBy:true },
  { key:'bills', displayName:'Bills', table:'bills', numberColumn:'bill_no', kind:'bill', lineTable:'bill_lines', lineForeignKey:'bill_id', party:'vendor', legacy:true, createdBy:true },
  { key:'expenses', displayName:'Expenses', table:'expenses', numberColumn:'expense_no', kind:'expense', lineTable:'expense_lines', lineForeignKey:'expense_id', legacy:true, createdBy:true },
  { key:'journal-entries', displayName:'Journal Entries', table:'journal_entries', numberColumn:'entry_no', kind:'journal', lineTable:'journal_lines', lineForeignKey:'journal_id', legacy:true, createdBy:true },
  { key:'sales-receipts', displayName:'Sales Receipts', table:'sales_receipts', numberColumn:'receipt_no', kind:'salesReceipt', lineTable:'sales_receipt_lines', lineForeignKey:'sales_receipt_id', party:'customer', legacy:true },
  { key:'purchase-orders', displayName:'Purchase Orders', table:'purchase_orders', numberColumn:'po_no', kind:'purchaseOrder', lineTable:'purchase_order_lines', lineForeignKey:'purchase_order_id', party:'vendor' },
  { key:'vendor-credits', displayName:'Supplier Credits', table:'vendor_credits', numberColumn:'credit_no', kind:'vendorCredit', lineTable:'vendor_credit_lines', lineForeignKey:'vendor_credit_id', party:'vendor', legacy:true },
  { key:'estimates', displayName:'Estimates', table:'estimates', numberColumn:'estimate_no', kind:'estimate', lineTable:'estimate_lines', lineForeignKey:'estimate_id', party:'customer' },
  { key:'customer-payments', displayName:'Customer Payments', table:'payments', numberColumn:'payment_no', kind:'customerPayment', legacy:true },
  { key:'vendor-payments', displayName:'Vendor Payments', table:'payments', numberColumn:'payment_no', kind:'vendorPayment', legacy:true },
]

function text(v: unknown) { return parseOptionalString(v) ?? undefined }
function parseRow(m: Record<string, unknown>) {
  let lines: any[] = []
  if (Array.isArray(m.lines)) lines = m.lines
  else if (typeof m.lines === 'string' && m.lines.trim()) { try { lines = JSON.parse(m.lines) } catch { lines = [] } }
  let allocations:QuickBooksPaymentAllocation[]=[];if(Array.isArray(m.allocations))allocations=m.allocations as QuickBooksPaymentAllocation[];else if(typeof m.allocations==='string'&&m.allocations.trim()){try{allocations=JSON.parse(m.allocations) as QuickBooksPaymentAllocation[]}catch{allocations=[]}}
  let relationshipIssues:string[]=[];if(Array.isArray(m.relationshipIssues))relationshipIssues=m.relationshipIssues.map(String);else if(typeof m.relationshipIssues==='string'&&m.relationshipIssues.trim()){try{relationshipIssues=(JSON.parse(m.relationshipIssues) as unknown[]).map(String)}catch{relationshipIssues=['QuickBooks payment relationships could not be parsed.']}}
  const total = parseNumberField(m.total ?? m.amount, 0)
  const transactionNo=String(m.transactionNo ?? '').trim()
  return { ...m, sourceId:text(m.sourceId), transactionNo, date:text(m.date), dueDate:text(m.dueDate), expiryDate:text(m.expiryDate), expectedDate:text(m.expectedDate), customerName:text(m.customerName), customerSourceId:text(m.customerSourceId), vendorName:text(m.vendorName), vendorSourceId:text(m.vendorSourceId), amount:parseNumberField(m.amount,total), subtotal:parseNumberField(m.subtotal,total), taxAmount:parseNumberField(m.taxAmount,0), total, status:text(m.status), currency:(text(m.currency) ?? 'USD').toUpperCase(), exchangeRate:parseNumberField(m.exchangeRate,1), homeTotal:parseNumberField(m.homeTotal,total*parseNumberField(m.exchangeRate,1)), reference:text(m.reference), description:text(m.description) ?? `Imported QuickBooks transaction ${transactionNo}`, category:text(m.category), paymentMethod:text(m.paymentMethod),paymentMethodSourceId:text(m.paymentMethodSourceId),depositAccountSourceId:text(m.depositAccountSourceId),apAccountSourceId:text(m.apAccountSourceId), invoiceNo:text(m.invoiceNo), billNo:text(m.billNo), relatedSourceId:text(m.relatedSourceId), allocations,unappliedAmount:parseNumberField(m.unappliedAmount,0),relationshipIssues,lines,sourcePayloadHash:typeof m._quickbooksRaw==='string'?createHash('sha256').update(m._quickbooksRaw).digest('hex'):undefined }
}

async function resolveSalesReceiptLineAccount(companyId:string,realmId:string|undefined,line:Record<string,unknown>){
  if(line.accountSourceId&&realmId){const account=await resolveQuickBooksLocalId(companyId,realmId,String(line.accountSourceId),['Account'],['chart_of_accounts']);if(account)return account.id}
  if(line.itemSourceId&&realmId){const archived=await createAdminClient().from('quickbooks_migration_records').select('source_payload').eq('company_id',companyId).eq('realm_id',realmId).eq('entity_type','Item').eq('source_id',String(line.itemSourceId)).maybeSingle();if(archived.error)throw archived.error;const payload=(archived.data?.source_payload??{}) as Record<string,unknown>,reference=payload.IncomeAccountRef as Record<string,unknown>|undefined;if(reference?.value){const account=await resolveQuickBooksLocalId(companyId,realmId,String(reference.value),['Account'],['chart_of_accounts']);if(account)return account.id}}
  return undefined
}

async function sourceDocumentMatches(table:string,moduleKey:string,companyId:string,id:string,hash?:string){if(!hash)return false;const db=createAdminClient(),[document,run]=await Promise.all([db.from(table).select('source_payload_hash').eq('company_id',companyId).eq('id',id).maybeSingle(),db.from('quickbooks_materialization_runs').select('status').eq('company_id',companyId).eq('module_key',moduleKey).eq('local_id',id).maybeSingle()]);if(document.error)throw document.error;if(run.error)throw run.error;return String(document.data?.source_payload_hash??'')===hash&&run.data?.status==='completed'}

async function resolveVendorCreditLineAccount(companyId:string,realmId:string|undefined,line:Record<string,unknown>,itemId?:string){
  if(line.accountSourceId&&realmId){const account=await resolveQuickBooksLocalId(companyId,realmId,String(line.accountSourceId),['Account'],['chart_of_accounts']);if(account)return account.id}
  if(line.itemSourceId&&realmId){const archived=await createAdminClient().from('quickbooks_migration_records').select('source_payload').eq('company_id',companyId).eq('realm_id',realmId).eq('entity_type','Item').eq('source_id',String(line.itemSourceId)).maybeSingle();if(archived.error)throw archived.error;const payload=(archived.data?.source_payload??{}) as Record<string,unknown>,reference=(String(payload.Type??'')==='Inventory'?payload.AssetAccountRef:payload.ExpenseAccountRef) as Record<string,unknown>|undefined;if(reference?.value){const account=await resolveQuickBooksLocalId(companyId,realmId,String(reference.value),['Account'],['chart_of_accounts']);if(account)return account.id}}
  if(itemId){const item=await createAdminClient().from('inventory_items').select('inventory_asset_account_id').eq('company_id',companyId).eq('id',itemId).maybeSingle();if(item.error)throw item.error;if(item.data?.inventory_asset_account_id)return String(item.data.inventory_asset_account_id)}
  return undefined
}
async function vendorCreditSourceMatches(companyId:string,id:string,hash?:string){return sourceDocumentMatches('vendor_credits','vendor-credits',companyId,id,hash)}

async function preservePaymentAllocations(input:{companyId:string;realmId?:string;paymentId:string;kind:'customerPayment'|'vendorPayment';row:ReturnType<typeof parseRow>;fallbackTargetId?:string}){
  const {companyId,realmId,paymentId,kind,row,fallbackTargetId}=input
  if(row.relationshipIssues.length)throw new Error(`QuickBooks payment relationship is not certifiable: ${row.relationshipIssues.join(' ')}`)
  if(row.allocations.length){if(!realmId||!row.sourceId)throw new Error('QuickBooks payment allocations require realm and source identifiers.');const resolved=await resolveQuickBooksPaymentAllocations({companyId,realmId,sourcePaymentId:row.sourceId,kind:kind==='customerPayment'?'CUSTOMER':'VENDOR',currency:row.currency,exchangeRate:row.exchangeRate,allocations:row.allocations});await replacePaymentAllocations(companyId,paymentId,resolved);return}
  if(fallbackTargetId)await replacePaymentAllocations(companyId,paymentId,[{invoiceId:kind==='customerPayment'?fallbackTargetId:null,billId:kind==='vendorPayment'?fallbackTargetId:null,amount:row.amount,cashAmount:row.amount,creditAmount:0,currency:row.currency,exchangeRate:row.exchangeRate,sourceSystem:row.sourceId?'QUICKBOOKS':'HISAB',sourcePaymentId:row.sourceId,sourceLineKey:'legacy:0',sourceTargetId:row.relatedSourceId}])
  else await replacePaymentAllocations(companyId,paymentId,[])
}

async function paymentAllocationsMatch(companyId:string,paymentId:string,realmId:string|undefined,kind:'customerPayment'|'vendorPayment',row:ReturnType<typeof parseRow>){
  if(!realmId||!row.sourceId||row.relationshipIssues.length)return false
  const expected=await resolveQuickBooksPaymentAllocations({companyId,realmId,sourcePaymentId:row.sourceId,kind:kind==='customerPayment'?'CUSTOMER':'VENDOR',currency:row.currency,exchangeRate:row.exchangeRate,allocations:row.allocations}),db=createAdminClient()
  const expectedDepositAccount=kind==='customerPayment'&&row.depositAccountSourceId?await resolveQuickBooksLocalId(companyId,realmId,row.depositAccountSourceId,['Account'],['chart_of_accounts']):null
  if(kind==='customerPayment'&&row.depositAccountSourceId&&!expectedDepositAccount)return false
  const [payment,actual]=await Promise.all([db.from('payments').select('amount,exchange_rate,deposit_account_id').eq('company_id',companyId).eq('id',paymentId).maybeSingle(),db.from('payment_allocations').select('invoice_id,bill_id,amount,cash_amount,credit_amount,currency,exchange_rate,source_line_key,source_target_id,source_credit_ids,local_credit_ids').eq('company_id',companyId).eq('payment_id',paymentId).eq('source_system','QUICKBOOKS').order('source_line_key')])
  if(payment.error)throw payment.error;if(actual.error)throw actual.error;if(!payment.data||Math.abs(Number(payment.data.amount)-row.amount)>0.0001||Math.abs(Number(payment.data.exchange_rate??1)-row.exchangeRate)>0.00000001)return false
  if(kind==='customerPayment'&&String(payment.data.deposit_account_id??'')!==String(expectedDepositAccount?.id??''))return false
  const canonical=(item:Record<string,unknown>)=>JSON.stringify({invoiceId:item.invoiceId??item.invoice_id??null,billId:item.billId??item.bill_id??null,amount:Number(item.amount),cashAmount:Number(item.cashAmount??item.cash_amount),creditAmount:Number(item.creditAmount??item.credit_amount),currency:String(item.currency),exchangeRate:Number(item.exchangeRate??item.exchange_rate??1),sourceLineKey:String(item.sourceLineKey??item.source_line_key),sourceTargetId:String(item.sourceTargetId??item.source_target_id),sourceCreditIds:[...((item.sourceCreditIds??item.source_credit_ids??[]) as string[])].sort(),localCreditIds:[...((item.localCreditIds??item.local_credit_ids??[]) as string[])].sort()})
  return expected.map(item=>canonical(item as unknown as Record<string,unknown>)).sort().join('|')===(actual.data??[]).map(item=>canonical(item)).sort().join('|')
}

async function preserveQuickBooksFx(companyId:string,row:ReturnType<typeof parseRow>){
  if(!row.date||!row.currency||!Number.isFinite(row.exchangeRate)||row.exchangeRate<=0)return
  const db=createAdminClient();const company=await db.from('companies').select('currency').eq('id',companyId).single();if(company.error)throw company.error
  const home=String(company.data.currency??row.currency).toUpperCase()
  const active=await db.from('company_currencies').upsert({company_id:companyId,code:row.currency,name:row.currency,is_primary:row.currency===home,is_active:true},{onConflict:'company_id,code'});if(active.error)throw active.error
  if(row.currency!==home){const stored=await db.from('exchange_rates').upsert({company_id:companyId,from_currency:row.currency,to_currency:home,rate:row.exchangeRate,effective_date:new Date(`${String(row.date).slice(0,10)}T00:00:00.000Z`).toISOString(),source:'QUICKBOOKS_TRANSACTION',is_manual_override:true,notes:`QuickBooks transaction ${row.sourceId??row.transactionNo}`},{onConflict:'company_id,from_currency,to_currency,effective_date'});if(stored.error)throw stored.error}
}

async function lookup(table: string, companyId: string, name?: string) {
  if (!name) return undefined
  const { data } = await createAdminClient().from(table).select('id').eq('company_id', companyId).eq('name', name).is('deleted_at', null).limit(1).maybeSingle()
  return data?.id as string | undefined
}
async function accountId(companyId: string, accountNo?: string) {
  if (!accountNo) return undefined
  const client = createAdminClient()
  const first = await client.from('chart_of_accounts').select('id').eq('company_id', companyId).eq('account_no', accountNo).is('deleted_at', null).limit(1).maybeSingle()
  if (first.data?.id) return first.data.id as string
  const { data } = await client.from('chart_of_accounts').select('id').eq('company_id', companyId).eq('name', accountNo).is('deleted_at', null).limit(1).maybeSingle()
  return data?.id as string | undefined
}
async function relatedId(table: string, companyId: string, numberColumn: string, number?: string, sourceId?: string) {
  if (!number && !sourceId) return undefined
  let q = createAdminClient().from(table).select('id').eq('company_id', companyId).is('deleted_at', null)
  if (sourceId) q = q.eq('legacy_id', sourceId)
  else q = q.eq(numberColumn, number)
  const { data } = await q.limit(1).maybeSingle(); return data?.id as string | undefined
}

async function rollbackTransactionRecord(c:Config,id:string,ctx:{companyId:string}){
  const db=createAdminClient()
  const ledger=await db.from('ledger_entries').select('id').eq('company_id',ctx.companyId).eq('source_id',id).limit(1);if(ledger.error)throw ledger.error
  if(ledger.data?.length)throw new Error(`Cannot delete ${c.key} ${id} because ledger posting already exists; retry materialization instead.`)
  if(c.lineTable){const lines=await db.from(c.lineTable).delete().eq('company_id',ctx.companyId).eq(c.lineForeignKey!,id);if(lines.error)throw lines.error}
  const allocations=await db.from('payment_allocations').delete().eq('company_id',ctx.companyId).eq('payment_id',id);if(allocations.error&&c.table==='payments')throw allocations.error
  const materialization=await db.from('quickbooks_materialization_runs').delete().eq('company_id',ctx.companyId).eq('module_key',c.key).eq('local_id',id);if(materialization.error)throw materialization.error
  const links=await db.from('quickbooks_migration_local_links').delete().eq('company_id',ctx.companyId).eq('local_table',c.table).eq('local_id',id);if(links.error)throw links.error
  const unlinked=await db.from('quickbooks_migration_records').update({local_table:null,local_id:null,imported_at:null}).eq('company_id',ctx.companyId).eq('local_table',c.table).eq('local_id',id);if(unlinked.error)throw unlinked.error
  const removed=await db.from(c.table).delete().eq('company_id',ctx.companyId).eq('id',id);if(removed.error)throw removed.error
}

function makeModule(c: Config): ModuleDefinition {
  const duplicateKeys = ['transactionNo', ...(c.legacy ? ['sourceId'] : [])]
  return {
    key:c.key, displayName:c.displayName, fields, duplicateKeys,
    parseImportRow: (m) => parseRow(m),
    async findDuplicate(record, ctx) {
      const r = parseRow(record); const client = createAdminClient()
      if (c.legacy && r.sourceId) { const { data } = await client.from(c.table).select('id').eq('company_id',ctx.companyId).eq('legacy_id',r.sourceId).is('deleted_at',null).limit(1).maybeSingle(); if (data) return {id:data.id,matchedOn:['sourceId']} }
      const { data } = await client.from(c.table).select('id').eq('company_id',ctx.companyId).eq(c.numberColumn,r.transactionNo).is('deleted_at',null).limit(1).maybeSingle()
      return data ? {id:data.id,matchedOn:['transactionNo']} : null
    },
    async findDuplicatesBatch(rows: MappedRow[], ctx): Promise<DuplicateMatch[]> {
      const parsed=rows.map(row=>({rowNumber:row.rowNumber,record:parseRow(row.mapped)})),client=createAdminClient()
      const sourceIds=[...new Set(parsed.map(item=>item.record.sourceId).filter((value):value is string=>Boolean(value)))]
      const numbers=[...new Set(parsed.map(item=>item.record.transactionNo).filter(Boolean))]
      const [sourceMatches,numberMatches]=await (ctx.performance?.measureOperation('duplicate_batch_queries', () => Promise.all([
        c.legacy&&sourceIds.length?client.from(c.table).select('*').eq('company_id',ctx.companyId).in('legacy_id',sourceIds).is('deleted_at',null):Promise.resolve({data:[],error:null}),
        numbers.length?client.from(c.table).select('*').eq('company_id',ctx.companyId).in(c.numberColumn,numbers).is('deleted_at',null):Promise.resolve({data:[],error:null}),
      ])) ?? Promise.all([
        c.legacy&&sourceIds.length?client.from(c.table).select('*').eq('company_id',ctx.companyId).in('legacy_id',sourceIds).is('deleted_at',null):Promise.resolve({data:[],error:null}),
        numbers.length?client.from(c.table).select('*').eq('company_id',ctx.companyId).in(c.numberColumn,numbers).is('deleted_at',null):Promise.resolve({data:[],error:null}),
      ]))
      if(sourceMatches.error)throw sourceMatches.error
      if(numberMatches.error)throw numberMatches.error
      const bySource=new Map((sourceMatches.data??[]).map(item=>[String(item.legacy_id),String(item.id)]))
      const byNumber=new Map((numberMatches.data??[]).map(item=>[String(item[c.numberColumn]),String(item.id)]))
      const matches:DuplicateMatch[]=[]
      for(const item of parsed){const sourceId=item.record.sourceId?bySource.get(item.record.sourceId):undefined,numberId=byNumber.get(item.record.transactionNo),existingId=sourceId??numberId;if(existingId)matches.push({rowNumber:item.rowNumber,existingId,matchedOn:sourceId?['sourceId']:['transactionNo']})}
      return matches
    },
    async createRecord(record, ctx) {
      const r=parseRow(record); const realmId=text(record._realmId); const customerContext=r.customerSourceId&&realmId?await resolveQuickBooksCustomerContext(ctx.companyId,realmId,r.customerSourceId):null; const vendorLink=r.vendorSourceId&&realmId?await resolveQuickBooksLocalId(ctx.companyId,realmId,r.vendorSourceId,['Vendor'],['vendors']):null; const customerId=customerContext?.customerId??await lookup('customers',ctx.companyId,r.customerName); const vendorId=vendorLink?.id??await lookup('vendors',ctx.companyId,r.vendorName)
      await preserveQuickBooksFx(ctx.companyId,r)
      if (c.party==='customer' && r.customerName && !customerId) throw new Error(`Customer "${r.customerName}" not found`)
      if (c.party==='vendor' && r.vendorName && !vendorId) throw new Error(`Vendor "${r.vendorName}" not found`)
      if(c.kind==='invoice') {
        if(!customerId) throw new Error('Customer relationship is required for invoice materialization')
        const nativeLines=[]
        for(const line of r.lines as any[]) {
          if(String(line.detailType)==='SubTotalLineDetail')continue
          const accountLink=line.accountSourceId&&realmId?await resolveQuickBooksLocalId(ctx.companyId,realmId,String(line.accountSourceId),['Account'],['chart_of_accounts']):null
          const itemLink=line.itemSourceId&&realmId?await resolveQuickBooksInventoryItemId(ctx.companyId,realmId,String(line.itemSourceId)):null
          const classLink=line.classSourceId&&realmId?await resolveQuickBooksLocalId(ctx.companyId,realmId,String(line.classSourceId),['Class'],['cost_centers']):null
          const parsedTax=Number(line.taxRate); const fallbackRate=r.subtotal>0?(r.taxAmount/r.subtotal)*100:0
          nativeLines.push({description:String(line.description??r.description??'Imported QuickBooks line'),quantity:Number(line.quantity??1),unitPrice:Number(line.unitPrice??line.amount??0),taxRate:Number.isFinite(parsedTax)?parsedTax:fallbackRate,accountId:accountLink?.id??await accountId(ctx.companyId,line.accountNo)??null,costCenterId:classLink?.id??customerContext?.projectId??null,projectId:customerContext?.projectId??null,inventoryItemId:itemLink?.id??null})
        }
        const invoice=await getInvoiceRepository().create({companyId:ctx.companyId,documentNo:r.transactionNo,legacyId:r.sourceId,status:r.status??'SENT',reference:r.reference,customerId,date:r.date??new Date(),dueDate:r.dueDate??r.date??new Date(),currency:r.currency,lines:nativeLines,notes:r.description,createdById:ctx.userId})
        try { const fx=await createAdminClient().from('invoices').update({exchange_rate:r.exchangeRate,base_subtotal:r.subtotal*r.exchangeRate,base_tax_amount:r.taxAmount*r.exchangeRate,base_total:r.homeTotal}).eq('company_id',ctx.companyId).eq('id',invoice.id);if(fx.error)throw fx.error
          return {id:invoice.id}
        } catch(error) { await rollbackTransactionRecord(c,invoice.id,ctx); throw error }
      }
      let safeNumber = r.transactionNo
      const existingNumber = await createAdminClient().from(c.table).select('id').eq('company_id',ctx.companyId).eq(c.numberColumn,safeNumber).is('deleted_at',null).limit(1).maybeSingle()
      if (existingNumber.data?.id) {
        for (let suffix = 1; suffix < 1000; suffix++) {
          const candidate = `${r.transactionNo}-COPY${suffix > 1 ? `-${suffix}` : ''}`
          const probe = await createAdminClient().from(c.table).select('id').eq('company_id',ctx.companyId).eq(c.numberColumn,candidate).is('deleted_at',null).limit(1).maybeSingle()
          if (!probe.data?.id) { safeNumber = candidate; break }
        }
      }
      const header:any={company_id:ctx.companyId,[c.numberColumn]:safeNumber,date:r.date}
      if (!['customerPayment','vendorPayment'].includes(c.kind)) header.status=r.status ?? 'OPEN'
      if (['salesReceipt','purchaseOrder','vendorCredit','estimate'].includes(c.kind)) Object.assign(header,{currency:r.currency,subtotal:r.subtotal,tax_amount:r.taxAmount,total:r.total,notes:r.description,exchange_rate:r.exchangeRate,base_total:r.homeTotal})
      if (c.kind==='bill') Object.assign(header,{subtotal:r.subtotal,tax_amount:r.taxAmount,total:r.total,notes:r.description,exchange_rate:r.exchangeRate,base_total:r.homeTotal})
      if(c.kind==='vendorCredit'){const ap=r.apAccountSourceId&&realmId?await resolveQuickBooksLocalId(ctx.companyId,realmId,r.apAccountSourceId,['Account'],['chart_of_accounts']):null;if(r.apAccountSourceId&&!ap)throw new Error(`QuickBooks A/P account ${r.apAccountSourceId} must be migrated before Vendor Credit ${r.sourceId}.`);Object.assign(header,{reference:r.reference,ap_account_id:ap?.id??null,base_subtotal:r.subtotal*r.exchangeRate,base_tax_amount:r.taxAmount*r.exchangeRate,balance:r.total,applied_amount:0,source_payload_hash:r.sourcePayloadHash})}
      if(c.kind==='salesReceipt'){
        if(!realmId)throw new Error('QuickBooks realm is required for Sales Receipt materialization.')
        if(!r.depositAccountSourceId)throw new Error(`QuickBooks Sales Receipt ${r.sourceId} has no certifiable deposit account.`)
        const deposit=await resolveQuickBooksLocalId(ctx.companyId,realmId,r.depositAccountSourceId,['Account'],['chart_of_accounts'])
        if(!deposit)throw new Error(`QuickBooks deposit account ${r.depositAccountSourceId} must be migrated before Sales Receipt ${r.sourceId}.`)
        let paymentMethodId:string|null=null
        if(r.paymentMethodSourceId){const link=await resolveQuickBooksLocalId(ctx.companyId,realmId,r.paymentMethodSourceId,['PaymentMethod'],['payment_methods']);paymentMethodId=link?.id??null}
        if(!paymentMethodId&&r.paymentMethod){const method=await createAdminClient().from('payment_methods').select('id').eq('company_id',ctx.companyId).ilike('name',r.paymentMethod).is('deleted_at',null).maybeSingle();if(method.error)throw method.error;paymentMethodId=method.data?.id??null}
        Object.assign(header,{legacy_id:r.sourceId??r.transactionNo,deposit_account_id:deposit.id,source_deposit_account_id:r.depositAccountSourceId,payment_method_id:paymentMethodId,source_payment_method_id:r.paymentMethodSourceId??null,payment_method:r.paymentMethod??'Cash',reference:r.reference,base_subtotal:r.subtotal*r.exchangeRate,base_tax_amount:r.taxAmount*r.exchangeRate,source_payload_hash:r.sourcePayloadHash})
      }
      if (c.kind==='bill') Object.assign(header,{reference:r.reference,exchange_rate:r.exchangeRate,base_subtotal:r.subtotal*r.exchangeRate,base_tax_amount:r.taxAmount*r.exchangeRate,base_total:r.homeTotal})
      if (c.kind==='expense') Object.assign(header,{description:r.description || `Imported QuickBooks expense ${r.transactionNo}`,category:r.category ?? 'Other',total:r.total,tax_amount:r.taxAmount,exchange_rate:r.exchangeRate,base_total:r.homeTotal})
      if (c.kind==='journal') Object.assign(header,{description:r.description ?? '',reference:r.reference,total_debit:r.total,total_credit:r.total,currency:r.currency,exchange_rate:r.exchangeRate,base_total:r.homeTotal})
      if(c.legacy) header.legacy_id=r.sourceId ?? r.transactionNo; if(c.createdBy) header.created_by_id=ctx.userId
      if(c.party==='customer') header.customer_id=customerId; if(c.party==='vendor') header.vendor_id=vendorId
      if(c.kind==='bill') header.due_date=r.dueDate
      if(c.kind==='estimate') header.expiry_date=r.expiryDate
      if(c.kind==='purchaseOrder') header.expected_date=r.expectedDate
      if(c.kind==='salesReceipt'&&!header.payment_method) header.payment_method=r.paymentMethod
      let paymentTargetId:string|undefined
      if(c.kind==='customerPayment'||c.kind==='vendorPayment') { header.amount=r.amount; header.method=r.paymentMethod; header.reference=r.reference;header.exchange_rate=r.exchangeRate;header.base_amount=r.homeTotal;header.customer_id=c.kind==='customerPayment'?customerId:null;header.vendor_id=c.kind==='vendorPayment'?vendorId:null;if(c.kind==='customerPayment'&&r.depositAccountSourceId&&realmId){const depositAccount=await resolveQuickBooksLocalId(ctx.companyId,realmId,r.depositAccountSourceId,['Account'],['chart_of_accounts']);if(!depositAccount)throw new Error(`QuickBooks deposit account ${r.depositAccountSourceId} must be migrated before payment ${r.sourceId}.`);header.deposit_account_id=depositAccount.id} paymentTargetId=await relatedId(c.kind==='customerPayment'?'invoices':'bills',ctx.companyId,c.kind==='customerPayment'?'invoice_no':'bill_no',c.kind==='customerPayment'?r.invoiceNo:r.billNo,r.relatedSourceId); if(paymentTargetId) { if(c.kind==='customerPayment') header.invoice_id=paymentTargetId; else header.bill_id=paymentTargetId } }
      const {data,error}=await createAdminClient().from(c.table).insert(header).select('id').single(); if(error) throw error
      try {
        if(c.lineTable && r.lines.length) { const lineRows=[]; for (const [lineIndex,l] of (r.lines as any[]).entries()) { if(String(l.detailType)==='SubTotalLineDetail')continue; const accountLink=l.accountSourceId&&realmId?await resolveQuickBooksLocalId(ctx.companyId,realmId,String(l.accountSourceId),['Account'],['chart_of_accounts']):null; const itemLink=l.itemSourceId&&realmId?await resolveQuickBooksLocalId(ctx.companyId,realmId,String(l.itemSourceId),['Item'],['inventory_items']):null; const classLink=l.classSourceId&&realmId?await resolveQuickBooksLocalId(ctx.companyId,realmId,String(l.classSourceId),['Class'],['cost_centers']):null; const aid=c.kind==='vendorCredit'?await resolveVendorCreditLineAccount(ctx.companyId,realmId,l,itemLink?.id):c.kind==='salesReceipt'?await resolveSalesReceiptLineAccount(ctx.companyId,realmId,l):accountLink?.id??await accountId(ctx.companyId,l.accountNo); if(['journal','salesReceipt'].includes(c.kind)&&!aid)throw new Error(`QuickBooks ${c.displayName} line ${lineIndex+1} has no migrated account.`); const rawLineAmount=Number(l.amount??0); const line:any={[c.lineForeignKey!]:data.id,company_id:ctx.companyId,account_id:aid ?? null,description:l.description ?? r.description ?? `Imported QuickBooks ${c.kind} line`,quantity:l.quantity ?? 1,unit_price:l.unitPrice ?? l.amount ?? 0,amount:c.kind==='bill'?Math.abs(rawLineAmount):l.amount ?? 0,tax_rate:Number.isFinite(Number(l.taxRate))?Number(l.taxRate):r.subtotal>0?(r.taxAmount/r.subtotal)*100:0}; if(c.kind==='bill') line.is_reduction=rawLineAmount<0; if(c.kind==='expense'){delete line.quantity;delete line.unit_price} if(['bill','vendorCredit','salesReceipt'].includes(c.kind)) line.inventory_item_id=itemLink?.id??null; if(['bill','journal','vendorCredit','salesReceipt'].includes(c.kind)) line.cost_center_id=classLink?.id??null; if(['vendorCredit','salesReceipt'].includes(c.kind))Object.assign(line,{line_no:lineIndex+1,source_line_id:l.sourceLineId??null,detail_type:l.detailType??(c.kind==='salesReceipt'?'SalesItemLineDetail':'AccountBasedExpenseLineDetail'),source_account_id:l.accountSourceId??null,source_item_id:l.itemSourceId??null,source_class_id:l.classSourceId??null,source_tax_code_id:l.taxCodeSourceId??null,metadata:{raw:l}}); if(c.kind==='journal') { delete line.quantity; delete line.unit_price; delete line.amount; line.debit=l.debit??0; line.credit=l.credit??0 } lineRows.push(line) } const {error:le}=await createAdminClient().from(c.lineTable).insert(lineRows); if(le) throw le }
        if(c.kind==='customerPayment'||c.kind==='vendorPayment')await preservePaymentAllocations({companyId:ctx.companyId,realmId,paymentId:String(data.id),kind:c.kind,row:r,fallbackTargetId:paymentTargetId})
        return {id:data.id}
      } catch(error) { await rollbackTransactionRecord(c,String(data.id),ctx); throw error }
    },
    rollbackCreatedRecord(id,ctx){return rollbackTransactionRecord(c,id,ctx)},
    async updateRecord(id, record, ctx) { const r=parseRow(record),candidateRealm=text(record._realmId);if (await hasPostedLedger(ctx.companyId,c.key,id)) {if(c.kind==='vendorCredit'&&await vendorCreditSourceMatches(ctx.companyId,id,r.sourcePayloadHash))return;if((c.kind==='customerPayment'||c.kind==='vendorPayment')&&await paymentAllocationsMatch(ctx.companyId,id,candidateRealm,c.kind,r))return; const materializationStatus=await getQuickBooksMaterializationStatus(ctx.companyId,c.key,id,record); if(materializationStatus==='failed'||materializationStatus==='posting') { await materializeQuickBooksAccounting({companyId:ctx.companyId,userId:ctx.userId,moduleKey:c.key,localId:id,sourceRow:record}); return } const message='QuickBooks changed a document that is already posted in Hisab AI. Resolve the conflict instead of rewriting ledger history.'; await markQuickBooksMaterializationConflict({companyId:ctx.companyId,moduleKey:c.key,localId:id,sourceRow:record,message}); throw new Error(message) } await preserveQuickBooksFx(ctx.companyId,r); const patch:any={date:r.date}; if (!['customerPayment','vendorPayment'].includes(c.kind)) patch.status=r.status ?? 'OPEN'; if (['invoice','salesReceipt','purchaseOrder','vendorCredit','estimate'].includes(c.kind)) Object.assign(patch,{currency:r.currency,subtotal:r.subtotal,tax_amount:r.taxAmount,total:r.total,notes:r.description,exchange_rate:r.exchangeRate,base_total:r.homeTotal});if(c.kind==='bill')Object.assign(patch,{subtotal:r.subtotal,tax_amount:r.taxAmount,total:r.total,notes:r.description,exchange_rate:r.exchangeRate,base_total:r.homeTotal});if(['invoice','bill','vendorCredit'].includes(c.kind))Object.assign(patch,{base_subtotal:r.subtotal*r.exchangeRate,base_tax_amount:r.taxAmount*r.exchangeRate}); if(c.kind==='vendorCredit')Object.assign(patch,{reference:r.reference,source_payload_hash:r.sourcePayloadHash}); if(c.kind==='expense') Object.assign(patch,{description:r.description,category:r.category ?? 'Other',total:r.total,tax_amount:r.taxAmount,exchange_rate:r.exchangeRate,base_total:r.homeTotal}); if(c.kind==='journal') Object.assign(patch,{description:r.description ?? '',reference:r.reference,total_debit:r.total,total_credit:r.total,currency:r.currency,exchange_rate:r.exchangeRate,base_total:r.homeTotal}); if(c.kind==='customerPayment'||c.kind==='vendorPayment') Object.assign(patch,{amount:r.amount,method:r.paymentMethod,reference:r.reference,notes:r.description,exchange_rate:r.exchangeRate,base_amount:r.homeTotal}); if(c.kind==='customerPayment'&&r.depositAccountSourceId&&candidateRealm){const depositAccount=await resolveQuickBooksLocalId(ctx.companyId,candidateRealm,r.depositAccountSourceId,['Account'],['chart_of_accounts']);if(!depositAccount)throw new Error(`QuickBooks deposit account ${r.depositAccountSourceId} must be migrated before payment ${r.sourceId}.`);patch.deposit_account_id=depositAccount.id} if(c.party==='customer') patch.customer_id=await lookup('customers',ctx.companyId,r.customerName); if(c.party==='vendor') patch.vendor_id=await lookup('vendors',ctx.companyId,r.vendorName); const {error}=await createAdminClient().from(c.table).update(patch).eq('id',id).eq('company_id',ctx.companyId); if(error) throw error;if(c.kind==='customerPayment'||c.kind==='vendorPayment'){const realmId=text(record._realmId);const target=await relatedId(c.kind==='customerPayment'?'invoices':'bills',ctx.companyId,c.kind==='customerPayment'?'invoice_no':'bill_no',c.kind==='customerPayment'?r.invoiceNo:r.billNo,r.relatedSourceId);await preservePaymentAllocations({companyId:ctx.companyId,realmId,paymentId:id,kind:c.kind,row:r,fallbackTargetId:target})} },
    async exportRecords(filters, ctx) {
      const relationSelect = c.party === 'customer' ? ', customer:customers(name)' : c.party === 'vendor' ? ', vendor:vendors(name)' : c.kind === 'customerPayment' ? ', invoice:invoices(legacy_id, customer:customers(name))' : c.kind === 'vendorPayment' ? ', bill:bills(legacy_id, vendor:vendors(name))' : ''
      const {data}=await createAdminClient().from(c.table).select(`*${relationSelect}`).eq('company_id',ctx.companyId).is('deleted_at',null)
      const rows = data ?? []
      if (c.lineTable) {
        for (const row of rows as any[]) {
          const { data: lines } = await createAdminClient().from(c.lineTable!).select('*').eq(c.lineForeignKey!, row.id).eq('company_id',ctx.companyId)
          row._validationLines = lines ?? []
        }
      }
      if(c.kind==='customerPayment'||c.kind==='vendorPayment'){for(const row of rows as any[]){const {data:allocations}=await createAdminClient().from('payment_allocations').select('*').eq('company_id',ctx.companyId).eq('payment_id',row.id);row._validationAllocations=allocations??[]}}
      return rows
    },
    mapExportRow(record:any) { return {sourceId:record.legacy_id ?? '',transactionNo:record[c.numberColumn] ?? '',date:record.date ?? '',dueDate:record.due_date ?? '',expiryDate:record.expiry_date ?? '',expectedDate:record.expected_date ?? '',customerName:record.customer?.name ?? record.invoice?.customer?.name ?? '',vendorName:record.vendor?.name ?? record.bill?.vendor?.name ?? '',relatedSourceId:record.invoice?.legacy_id ?? record.bill?.legacy_id ?? '',amount:record.amount ?? record.total ?? 0,subtotal:record.subtotal ?? 0,taxAmount:record.tax_amount ?? 0,total:record.total ?? 0,status:record.status ?? '',currency:record.currency ?? '',reference:record.reference ?? '',description:record.description ?? record.notes ?? '',paymentMethod:record.method ?? record.payment_method ?? '',unappliedAmount:record.unapplied_amount??0,allocations:JSON.stringify(record._validationAllocations??[]),lines:JSON.stringify(record._validationLines ?? [])} },
  }
}

export const transactionModules = configs.map(makeModule)
export const transactionModuleMap = new Map(transactionModules.map((m) => [m.key, m]))
