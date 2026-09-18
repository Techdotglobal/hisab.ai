import 'server-only'
import { postBillToLedger, postExpenseToLedger, postInvoiceToLedger, postPaymentToLedger, postPayrollToLedger, postSalesReceiptToLedger, postVendorCreditToLedger } from '@/lib/accounting/document-posting'
import { postSourceDocumentToLedger } from '@/lib/accounting/posting-service'
import { createAdminClient } from '@/lib/supabase/admin'

type Row = Record<string,unknown>

async function postQuickBooksJournal(id:string,companyId:string,sourceRow:Row){const db=createAdminClient(),entry=await db.from('journal_entries').select('entry_no,date,description,currency,exchange_rate').eq('company_id',companyId).eq('id',id).single();if(entry.error)throw entry.error;const lines=await db.from('journal_lines').select('account_id,debit,credit,description,cost_center_id').eq('company_id',companyId).eq('journal_id',id);if(lines.error)throw lines.error;const rate=Number(sourceRow.exchangeRate??entry.data.exchange_rate??1);await postSourceDocumentToLedger({companyId,sourceType:'JOURNAL',sourceId:id,entryDate:new Date(String(entry.data.date)),description:String(entry.data.description),currency:String(entry.data.currency),lines:(lines.data??[]).map(line=>({accountId:String(line.account_id),debit:Number(line.debit),credit:Number(line.credit),description:String(line.description??entry.data.description),costCenterId:line.cost_center_id?String(line.cost_center_id):null,exchangeRateOverride:rate}))});const ledger=await db.from('ledger_entries').select('posting_sequence').eq('company_id',companyId).eq('source_type','JOURNAL').eq('source_id',id).order('posting_sequence',{ascending:false}).limit(1).maybeSingle();if(ledger.error)throw ledger.error;const updated=await db.from('journal_entries').update({status:'POSTED',posting_sequence:Number(ledger.data?.posting_sequence??0),exchange_rate:rate}).eq('company_id',companyId).eq('id',id);if(updated.error)throw updated.error}

const CONFIG: Record<string,{ table:string; sourceType:string; post?:(id:string,companyId:string,sourceRow:Row)=>Promise<unknown>; requiresLedger:boolean; checksInventory?:boolean; allowsCreditOnlyApplication?:boolean; manualReason?:string }> = {
  invoices:{ table:'invoices', sourceType:'INVOICE', post:postInvoiceToLedger, requiresLedger:true, checksInventory:true },
  bills:{ table:'bills', sourceType:'BILL', post:(id,companyId,row)=>postBillToLedger(id,companyId,text(row.currency)), requiresLedger:true, checksInventory:true },
  expenses:{ table:'expenses', sourceType:'EXPENSE', post:(id,companyId,row)=>postExpenseToLedger(id,companyId,text(row.currency)), requiresLedger:true },
  'customer-payments':{ table:'payments', sourceType:'PAYMENT', post:(id,companyId,row)=>postPaymentToLedger(id,companyId,text(row.currency)), requiresLedger:true, allowsCreditOnlyApplication:true },
  'vendor-payments':{ table:'payments', sourceType:'PAYMENT', post:(id,companyId,row)=>postPaymentToLedger(id,companyId,text(row.currency)), requiresLedger:true, allowsCreditOnlyApplication:true },
  'journal-entries':{ table:'journal_entries', sourceType:'JOURNAL', post:postQuickBooksJournal, requiresLedger:true },
  payroll:{ table:'payroll_entries', sourceType:'PAYROLL', post:postPayrollToLedger, requiresLedger:true },
  estimates:{ table:'estimates', sourceType:'ESTIMATE', requiresLedger:false },
  'purchase-orders':{ table:'purchase_orders', sourceType:'PURCHASE_ORDER', requiresLedger:false },
  'sales-receipts':{ table:'sales_receipts', sourceType:'SALES_RECEIPT', post:postSalesReceiptToLedger, requiresLedger:true, checksInventory:true },
  'vendor-credits':{ table:'vendor_credits', sourceType:'SUPPLIER_CREDIT', post:postVendorCreditToLedger, requiresLedger:true, checksInventory:true },
  'qb-projects':{table:'cost_centers',sourceType:'PROJECT',requiresLedger:false},
  'qb-budgets':{table:'budgets',sourceType:'BUDGET',requiresLedger:false},
  'qb-exchange-rates':{table:'exchange_rates',sourceType:'EXCHANGE_RATE',requiresLedger:false},
  'qb-classes':{table:'cost_centers',sourceType:'CLASS',requiresLedger:false},
  'qb-departments':{table:'departments',sourceType:'DEPARTMENT',requiresLedger:false},
  'qb-employees':{table:'employees',sourceType:'EMPLOYEE',requiresLedger:false},
  'qb-time-activities':{table:'time_activities',sourceType:'TIME_ACTIVITY',requiresLedger:false},
  'qb-credit-memos':{table:'invoices',sourceType:'INVOICE',requiresLedger:true,checksInventory:true},
  'qb-deposits':{table:'bank_transactions',sourceType:'DEPOSIT',requiresLedger:true},
  'qb-transfers':{table:'bank_transactions',sourceType:'BANK_TRANSFER',requiresLedger:true},
  'qb-inventory-adjustments':{table:'stock_movements',sourceType:'INVENTORY',requiresLedger:false},
  'qb-attachments':{table:'attachments',sourceType:'ATTACHMENT',requiresLedger:false},
  'qb-recurring-transactions':{table:'recurring_transaction_templates',sourceType:'RECURRING',requiresLedger:false},
  'qb-tax-agencies':{table:'tax_agencies',sourceType:'TAX_AGENCY',requiresLedger:false},
  'qb-tax-configurations':{table:'tax_groups',sourceType:'TAX_CONFIGURATION',requiresLedger:false},
  'qb-preferences':{table:'companies',sourceType:'PREFERENCES',requiresLedger:false},
  'qb-fixed-assets':{table:'fixed_assets',sourceType:'FIXED_ASSET',requiresLedger:false},
}

function text(value:unknown) { return value === null || value === undefined ? '' : String(value) }

function requiresLedgerFor(config: (typeof CONFIG)[string], moduleKey:string, sourceRow:Row) {
  if (!config.requiresLedger) return false
  // QuickBooks permits zero-value journal documents, expenses, invoices, and
  // customer payments. They carry history and metadata but have no
  // accounting movement to post (e.g. NETKOM Expense 3966: total=0, every
  // line Amount=0; NETKOM Invoices 1166/1168: PAID, total=0; NETKOM
  // customer-payment 129: amount=0, which otherwise fails postPaymentToLedger's
  // validateBalanced() with "Entry must have non-zero amounts").
  if (moduleKey === 'journal-entries' || moduleKey === 'expenses' || moduleKey === 'invoices' || moduleKey === 'customer-payments') {
    const total = Number(sourceRow.total ?? sourceRow.amount ?? 0)
    if (Number.isFinite(total) && Math.abs(total) < 0.0001) return false
  }
  return true
}

export function tracksQuickBooksMaterialization(moduleKey:string){return Boolean(CONFIG[moduleKey])}

export async function hasPostedLedger(companyId:string,moduleKey:string,localId:string) {
  const config = CONFIG[moduleKey]
  if (!config?.requiresLedger) return false
  let query=createAdminClient().from('ledger_entries').select('id').eq('company_id',companyId).eq('source_id',localId)
  if(moduleKey!=='sales-receipts')query=query.eq('source_type',config.sourceType)
  const result = await query.limit(1)
  if (result.error) throw result.error
  return Boolean(result.data?.length)
}

export async function getQuickBooksMaterializationStatus(companyId:string,moduleKey:string,localId:string,sourceRow?:Row) {
  let query=createAdminClient().from('quickbooks_materialization_runs').select('status').eq('company_id',companyId).eq('module_key',moduleKey).eq('local_id',localId)
  const realmId=text(sourceRow?._realmId),entityType=text(sourceRow?._quickbooksEntity),sourceId=text(sourceRow?._quickbooksId??sourceRow?.sourceId)
  if(realmId&&entityType&&sourceId)query=query.eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId)
  else query=query.order('updated_at',{ascending:false}).limit(1)
  const result = await query.maybeSingle()
  if (result.error) throw result.error
  return result.data?.status ? String(result.data.status) : null
}

export async function assertQuickBooksAccountingCompleted(moduleKey:string,companyId:string,localId:string,sourceRow:Row) {
  const config=CONFIG[moduleKey]
  if(!config || !text(sourceRow._realmId)) return
  const result=await createAdminClient().from('quickbooks_materialization_runs').select('status,ledger_entry_count,last_error,validation').eq('company_id',companyId).eq('module_key',moduleKey).eq('local_id',localId).order('updated_at',{ascending:false}).limit(1).maybeSingle()
  if(result.error)throw result.error
  if(result.data?.status!=='completed')throw new Error(result.data?.last_error?`QuickBooks materialization did not complete: ${result.data.last_error}`:'QuickBooks materialization did not complete.')
  const validation=result.data?.validation&&typeof result.data.validation==='object'?result.data.validation as Row:{}
  if(requiresLedgerFor(config,moduleKey,sourceRow)&&Number(result.data.ledger_entry_count)<2&&!Boolean(validation.creditOnlyApplication))throw new Error(`QuickBooks ${moduleKey} materialization completed without a balanced ledger posting.`)
}

async function materializeQuickBooksAccountingImpl(input:{ companyId:string; userId:string; moduleKey:string; localId:string; sourceRow:Row }, forceReattempt:boolean) {
  const config = CONFIG[input.moduleKey]
  if (!config) return { status:'manual_required' as const, ledgerEntryCount:0, inventoryMovementCount:0 }
  const realmId = text(input.sourceRow._realmId)
  const entityType = text(input.sourceRow._quickbooksEntity)
  const sourceId = text(input.sourceRow._quickbooksId ?? input.sourceRow.sourceId)
  if (!realmId || !entityType || !sourceId) return { status:'not_quickbooks' as const, ledgerEntryCount:0, inventoryMovementCount:0 }
  const db = createAdminClient()
  const existing = await db.from('quickbooks_materialization_runs').select('*').eq('company_id',input.companyId).eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId).eq('module_key',input.moduleKey).maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data?.status === 'completed' && existing.data.local_id === input.localId) {
    if (!forceReattempt) {
      return { status:'completed' as const, ledgerEntryCount:Number(existing.data.ledger_entry_count), inventoryMovementCount:Number(existing.data.inventory_movement_count) }
    }
    // Force path (e.g. re-materializing a document whose prior "completed" run
    // predates a total-computation fix): only ever allowed when there is
    // provably zero existing ledger impact, checked twice — the cached count
    // on the run row AND a direct read of ledger_entries — so this can never
    // duplicate a real posting. A completed run with any ledger entries at all
    // is refused outright and execution never reaches config.post below.
    const cachedLedgerCount = Number(existing.data.ledger_entry_count ?? 0)
    if (cachedLedgerCount > 0) {
      throw new Error(`Refusing to force-rematerialize ${input.moduleKey} ${sourceId}: its materialization run already recorded ${cachedLedgerCount} ledger entries.`)
    }
    if (requiresLedgerFor(config,input.moduleKey,input.sourceRow)) {
      let realLedgerQuery = db.from('ledger_entries').select('id').eq('company_id',input.companyId).eq('source_id',input.localId)
      if (input.moduleKey !== 'sales-receipts') realLedgerQuery = realLedgerQuery.eq('source_type',config.sourceType)
      const realLedgerCheck = await realLedgerQuery.limit(1)
      if (realLedgerCheck.error) throw realLedgerCheck.error
      if ((realLedgerCheck.data?.length ?? 0) > 0) {
        throw new Error(`Refusing to force-rematerialize ${input.moduleKey} ${sourceId}: ledger_entries already contains a posting for local id ${input.localId}.`)
      }
    }
    // Falls through to the normal posting flow below — nothing else changes.
  }
  if (config.manualReason) {
    const manual = await db.from('quickbooks_materialization_runs').upsert({ company_id:input.companyId, realm_id:realmId, entity_type:entityType, source_id:sourceId, module_key:input.moduleKey, local_table:config.table, local_id:input.localId, status:'manual_required', attempt_count:Number(existing.data?.attempt_count ?? 0), validation:{ sourceId, reason:config.manualReason }, last_error:config.manualReason, updated_at:new Date().toISOString() }, { onConflict:'company_id,realm_id,entity_type,source_id,module_key' })
    if (manual.error) throw manual.error
    return { status:'manual_required' as const, ledgerEntryCount:0, inventoryMovementCount:0 }
  }
  const started = await db.from('quickbooks_materialization_runs').upsert({ company_id:input.companyId, realm_id:realmId, entity_type:entityType, source_id:sourceId, module_key:input.moduleKey, local_table:config.table, local_id:input.localId, status:'posting', attempt_count:Number(existing.data?.attempt_count ?? 0) + 1, started_at:new Date().toISOString(), last_error:null, updated_at:new Date().toISOString() }, { onConflict:'company_id,realm_id,entity_type,source_id,module_key' })
  if (started.error) throw started.error
  try {
    const requiresLedger=requiresLedgerFor(config,input.moduleKey,input.sourceRow)
    let creditOnlyApplication=false
    if(config.allowsCreditOnlyApplication){const [payment,allocations]=await Promise.all([db.from('payments').select('amount').eq('company_id',input.companyId).eq('id',input.localId).single(),db.from('payment_allocations').select('credit_amount').eq('company_id',input.companyId).eq('payment_id',input.localId)]);if(payment.error)throw payment.error;if(allocations.error)throw allocations.error;creditOnlyApplication=Number(payment.data.amount)===0&&(allocations.data??[]).reduce((sum,item)=>sum+Number(item.credit_amount),0)>0}
    if (config.post && requiresLedger&&!creditOnlyApplication) {
      const postingStage=await db.from('quickbooks_materialization_runs').update({validation:{sourceId,stage:'native_posting',stageStartedAt:new Date().toISOString()},updated_at:new Date().toISOString()}).eq('company_id',input.companyId).eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId).eq('module_key',input.moduleKey)
      if(postingStage.error)throw postingStage.error
      await config.post(input.localId,input.companyId,input.sourceRow)
    }
    const verificationStage=await db.from('quickbooks_materialization_runs').update({validation:{sourceId,stage:'ledger_verification',stageStartedAt:new Date().toISOString()},updated_at:new Date().toISOString()}).eq('company_id',input.companyId).eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId).eq('module_key',input.moduleKey)
    if(verificationStage.error)throw verificationStage.error
    const ledgerQuery=requiresLedger?db.from('ledger_entries').select('id').eq('company_id',input.companyId).eq('source_id',input.localId):null
    if(ledgerQuery&&input.moduleKey!=='sales-receipts')ledgerQuery.eq('source_type',config.sourceType)
    const ledger = ledgerQuery?await ledgerQuery:{data:[] as Array<{id:string}>,error:null}
    if (ledger.error) throw ledger.error
    const inventory = config.checksInventory ? await db.from('stock_movements').select('id').eq('company_id',input.companyId).eq('source_type',config.sourceType).eq('source_id',input.localId) : { data:[] as Array<{id:string}>, error:null }
    if (inventory.error) throw inventory.error
    const ledgerEntryCount = ledger.data?.length ?? 0
    const inventoryMovementCount = inventory.data?.length ?? 0
    if (requiresLedger && ledgerEntryCount < 2&&!creditOnlyApplication) {
      // Not every tracked table has the same diagnostic columns (e.g. `expenses`
      // has no `subtotal`, `payments`/`journal_entries` have neither `total` nor
      // `subtotal`) — select('*') so this diagnostic can never itself crash with
      // "column does not exist" and mask the real "unbalanced ledger" error.
      const document=await db.from(config.table).select('*').eq('company_id',input.companyId).eq('id',input.localId).maybeSingle()
      if(document.error)throw document.error
      const snapshot=document.data as Record<string,unknown>|null
      throw new Error(`Native ${input.moduleKey} posting did not produce a balanced ledger entry (ledgerEntries=${ledgerEntryCount}, status=${text(snapshot?.status)||'unknown'}, total=${text(snapshot?.total)||'unknown'}, subtotal=${text(snapshot?.subtotal)||'unknown'}, tax=${text(snapshot?.tax_amount)||'unknown'}).`)
    }
    const completed = await db.from('quickbooks_materialization_runs').update({ status:'completed', ledger_entry_count:ledgerEntryCount, inventory_movement_count:inventoryMovementCount, validation:{ balancedLedger:!requiresLedger || ledgerEntryCount >= 2 || creditOnlyApplication, zeroMovementDocument:config.requiresLedger&&!requiresLedger, creditOnlyApplication, inventoryChecked:Boolean(config.checksInventory), sourceId }, completed_at:new Date().toISOString(), updated_at:new Date().toISOString() }).eq('company_id',input.companyId).eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId).eq('module_key',input.moduleKey)
    if (completed.error) throw completed.error
    return { status:'completed' as const, ledgerEntryCount, inventoryMovementCount }
  } catch (error) {
    await db.from('quickbooks_materialization_runs').update({ status:'failed', last_error:error instanceof Error ? error.message : String(error), updated_at:new Date().toISOString() }).eq('company_id',input.companyId).eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId).eq('module_key',input.moduleKey)
    throw error
  }
}

export async function materializeQuickBooksAccounting(input:{ companyId:string; userId:string; moduleKey:string; localId:string; sourceRow:Row }) {
  return materializeQuickBooksAccountingImpl(input, false)
}

/**
 * Re-runs materialization for a document already marked `completed`, for the
 * narrow case where that prior completion is known to predate a bug fix and
 * therefore may not reflect a real posting (e.g. NETKOM Journal Entries whose
 * `total` was miscomputed as 0, so `postQuickBooksJournal` never ran).
 *
 * Never bypasses safety: refused outright (before any posting attempt) if the
 * existing run already recorded ledger entries, or if `ledger_entries` itself
 * already has a row for this document — checked directly, not just via the
 * cached count — so calling this twice, or calling it on a document that was
 * already correctly posted, can never create a duplicate posting. Every other
 * safeguard (balance validation, account resolution, diagnostic-on-failure)
 * is identical to the normal path — this only lifts the "already completed"
 * short-circuit, and only when zero ledger impact is proven first.
 */
export async function forceRematerializeQuickBooksAccounting(input:{ companyId:string; userId:string; moduleKey:string; localId:string; sourceRow:Row }) {
  return materializeQuickBooksAccountingImpl(input, true)
}

export async function markQuickBooksMaterializationConflict(input:{ companyId:string; moduleKey:string; localId:string; sourceRow:Row; message:string }) {
  const config = CONFIG[input.moduleKey]
  const realmId=text(input.sourceRow._realmId); const entityType=text(input.sourceRow._quickbooksEntity); const sourceId=text(input.sourceRow._quickbooksId ?? input.sourceRow.sourceId)
  if (!config || !realmId || !entityType || !sourceId) return
  const result = await createAdminClient().from('quickbooks_materialization_runs').upsert({ company_id:input.companyId, realm_id:realmId, entity_type:entityType, source_id:sourceId, module_key:input.moduleKey, local_table:config.table, local_id:input.localId, status:'conflict', last_error:input.message, updated_at:new Date().toISOString() }, { onConflict:'company_id,realm_id,entity_type,source_id,module_key' })
  if (result.error) throw result.error
}
