import 'server-only'
import { createHash } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  archiveQuickBooksRecord,
  findArchivedRecord,
  linkArchivedQuickBooksRecord,
  materializeQuickBooksCustomFields,
  parseQuickBooksRaw,
  recordQuickBooksWarning,
  resolveQuickBooksCustomerContext,
  resolveQuickBooksInventoryItemId,
  resolveQuickBooksLocalId,
} from '../../quickbooks/migration-store'
import type { FieldDefinition, ModuleDefinition } from '../../types'
import { processInventoryMovement } from '@/lib/inventory/movements'
import { postInventoryAdjustmentJournal } from '@/lib/inventory/journal-posting'
import { createBankTransfer } from '@/lib/banking/transfers'
import { getInvoiceRepository } from '@/lib/db/provider'
import { postInvoiceToLedger,postPaymentToLedger } from '@/lib/accounting/document-posting'
import { createBankDeposit } from '@/lib/banking/transactions'
import { extractQuickBooksPaymentRelationships } from '../../quickbooks/payment-relationships'
import { extractQuickBooksDepositRelationships } from '../../quickbooks/deposit-relationships'
import { replacePaymentAllocations,resolveQuickBooksPaymentAllocations } from '@/lib/accounting/payment-allocations'

type Row = Record<string, unknown>

const fields: FieldDefinition[] = [
  { key: 'sourceId', label: 'QuickBooks ID', type: 'string', required: true },
  { key: 'name', label: 'Name', type: 'string' },
  { key: 'code', label: 'Code / Number', type: 'string' },
  { key: 'type', label: 'Type', type: 'string' },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'updatedAt', label: 'Last Updated', type: 'date' },
  { key: 'amount', label: 'Amount', type: 'currency' },
  { key: 'currency', label: 'Currency', type: 'string' },
  { key: 'exchangeRate', label: 'Exchange Rate', type: 'number' },
  { key: 'parentSourceId', label: 'Parent QuickBooks ID', type: 'string' },
  { key: 'entitySourceId', label: 'Entity QuickBooks ID', type: 'string' },
  { key: 'accountSourceId', label: 'Account QuickBooks ID', type: 'string' },
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'description', label: 'Description', type: 'string' },
  { key: 'lines', label: 'Lines', type: 'string' },
]
const stable=(value:unknown):string=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value as Row).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`:JSON.stringify(value)??'null'

type ExtendedConfig = {
  key: string
  displayName: string
  entityType: string
  materialize?: (row: Row, companyId: string, userId: string, realmId: string) => Promise<{ id: string; table: string } | null>
}

function string(value: unknown, fallback = '') { return value === null || value === undefined ? fallback : String(value).trim() }
function number(value: unknown, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback }
function bool(value: unknown, fallback = true) { if (value === undefined || value === null || value === '') return fallback; return value === true || String(value).toLowerCase() === 'true' }
function date(value: unknown) { const parsed = new Date(string(value) || Date.now()); return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString() }
function safeStatus(value: unknown, allowed: string[], fallback: string) { const candidate = string(value).toUpperCase(); return allowed.includes(candidate) ? candidate : fallback }

async function upsertByLegacy(table: string, companyId: string, sourceId: string, values: Row) {
  const client = createAdminClient()
  const existing = await client.from(table).select('id').eq('company_id', companyId).eq('legacy_id', sourceId).limit(1).maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data?.id) {
    const update = await client.from(table).update(values).eq('id', existing.data.id).eq('company_id', companyId)
    if (update.error) throw update.error
    return String(existing.data.id)
  }
  const created = await client.from(table).insert({ company_id: companyId, legacy_id: sourceId, ...values }).select('id').single()
  if (created.error) throw created.error
  return String(created.data.id)
}

async function materializeCostCenter(row: Row, companyId: string, _userId: string, _realmId: string, type: string) {
  const raw = parseQuickBooksRaw(row)
  const sourceId = string(raw.Id ?? row.sourceId)
  const code = string(row.code, `QB-${sourceId}`)
  const id = await upsertByLegacy('cost_centers', companyId, sourceId, {
    code,
    name: string(row.name, code),
    type,
    description: string(row.description) || null,
    is_active: bool(raw.Active, true),
    deleted_at: bool(row._deleted, false) ? new Date().toISOString() : null,
  })
  return { id, table: 'cost_centers' }
}

async function materializeDepartment(row: Row, companyId: string) {
  const raw = parseQuickBooksRaw(row); const sourceId = string(raw.Id ?? row.sourceId); const code = string(row.code, `QB-${sourceId}`)
  const id = await upsertByLegacy('departments', companyId, sourceId, { code, name: string(row.name, code), description: string(row.description) || null, is_active: bool(raw.Active, true), deleted_at: bool(row._deleted, false) ? new Date().toISOString() : null })
  return { id, table: 'departments' }
}

async function materializeExchangeRate(row: Row, companyId: string) {
  const raw = parseQuickBooksRaw(row)
  const source = raw.SourceCurrencyCode ?? raw.SourceCurrencyRef ?? raw.FromCurrency ?? row.currency
  const target = raw.TargetCurrencyCode ?? raw.TargetCurrencyRef ?? raw.ToCurrency
  const from = string(typeof source === 'object' ? (source as Row).value : source)
  const to = string(typeof target === 'object' ? (target as Row).value : target)
  if (!from || !to) return null
  const values = { company_id: companyId, from_currency: from, to_currency: to, rate: number(raw.Rate ?? row.exchangeRate, 1), effective_date: date(raw.AsOfDate ?? row.date) }
  const result = await createAdminClient().from('exchange_rates').upsert(values, { onConflict: 'company_id,from_currency,to_currency,effective_date' }).select('id').single()
  if (result.error) throw result.error
  return { id: String(result.data.id), table: 'exchange_rates' }
}

async function materializeEmployee(row: Row, companyId: string, _userId: string, realmId: string) {
  const raw = parseQuickBooksRaw(row); const sourceId = string(raw.Id ?? row.sourceId)
  const departmentRef = raw.DepartmentRef && typeof raw.DepartmentRef === 'object' ? string((raw.DepartmentRef as Row).value) : ''
  const department = departmentRef ? await resolveQuickBooksLocalId(companyId, realmId, departmentRef, ['Department']) : null
  const displayName = string(raw.DisplayName ?? [raw.GivenName, raw.FamilyName].filter(Boolean).join(' ') ?? row.name, `QB Employee ${sourceId}`)
  const id = await upsertByLegacy('employees', companyId, sourceId, {
    employee_no: string(raw.EmployeeNumber ?? row.code, `QB-${sourceId}`), name: displayName,
    email: string((raw.PrimaryEmailAddr as Row | undefined)?.Address) || null,
    phone: string((raw.PrimaryPhone as Row | undefined)?.FreeFormNumber) || null,
    department: string((raw.DepartmentRef as Row | undefined)?.name) || null, department_id: department?.id ?? null,
    position: string(raw.Title) || null, joining_date: date(raw.HiredDate ?? (raw.MetaData && (raw.MetaData as Row).CreateTime)),
    salary: 0, salary_type: 'MONTHLY', bank_account: null, is_active: bool(raw.Active, true),
    deleted_at: bool(row._deleted, false) ? new Date().toISOString() : null,
  })
  return { id, table: 'employees' }
}

async function materializeBudget(row: Row, companyId: string, _userId: string, realmId: string) {
  const raw = parseQuickBooksRaw(row); const sourceId = string(raw.Id ?? row.sourceId); const start = new Date(string(raw.StartDate ?? row.date) || Date.now())
  const name = string(raw.Name ?? row.name, `QuickBooks Budget ${sourceId}`)
  const existing = await createAdminClient().from('budgets').select('id').eq('company_id', companyId).eq('name', name).eq('fiscal_year', start.getUTCFullYear()).maybeSingle()
  if (existing.error) throw existing.error
  let budgetId = existing.data?.id as string | undefined
  if (!budgetId) {
    const created = await createAdminClient().from('budgets').insert({ company_id: companyId, name, fiscal_year: start.getUTCFullYear(), status: safeStatus(raw.Active === false ? 'ARCHIVED' : row.status, ['DRAFT','ACTIVE','CLOSED','ARCHIVED'], 'ACTIVE') }).select('id').single()
    if (created.error) throw created.error
    budgetId = String(created.data.id)
  }
  const details = Array.isArray(raw.BudgetDetail) ? raw.BudgetDetail : Array.isArray(raw.Line) ? raw.Line : []
  for (const detail of details as Row[]) {
    const accountRef = detail.AccountRef as Row | undefined; const accountSourceId = string(accountRef?.value)
    if (!accountSourceId) continue
    const account = await resolveQuickBooksLocalId(companyId, realmId, accountSourceId, ['Account'])
    if (!account) continue
    const detailDate = new Date(string(detail.BudgetDate ?? detail.Date) || start)
    const result = await createAdminClient().from('budget_lines').upsert({ company_id: companyId, budget_id: budgetId, account_id: account.id, period_month: detailDate.getUTCMonth() + 1, amount: number(detail.Amount) }, { onConflict: 'budget_id,account_id,period_month' })
    if (result.error) throw result.error
  }
  return { id: budgetId, table: 'budgets' }
}

async function materializeRecurring(row: Row, companyId: string, userId: string) {
  const raw = parseQuickBooksRaw(row); const sourceId = string(raw.Id ?? row.sourceId); const templateName = string(raw.Name ?? row.name, `QuickBooks Recurring ${sourceId}`)
  const typeMap: Record<string, string> = { CreditMemo:'CREDIT_NOTE', BillPayment:'PAYMENT', SalesReceipt:'SALES_RECEIPT', VendorCredit:'SUPPLIER_CREDIT', PurchaseOrder:'PURCHASE_ORDER', JournalEntry:'JOURNAL_ENTRY' }
  const txnType = string(raw.TransactionType ?? raw.TxnType ?? row.type).replace(/[^A-Za-z]/g, '')
  const transactionType = typeMap[txnType] ?? txnType.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
  const allowed = ['BILL','NON_POSTING_CHARGE','CHEQUE','NON_POSTING_CREDIT','CREDIT_CARD_CREDIT','CREDIT_NOTE','DEPOSIT','ESTIMATE','EXPENSE','INVOICE','JOURNAL_ENTRY','PAYMENT','SALES_RECEIPT','TRANSFER','SUPPLIER_CREDIT','PURCHASE_ORDER']
  const values = { company_id: companyId, template_name: templateName, recurrence_type: safeStatus(raw.RecurrenceType, ['REMINDER','SCHEDULED','UNSCHEDULED'], 'SCHEDULED'), transaction_type: allowed.includes(transactionType) ? transactionType : 'JOURNAL_ENTRY', description: string(row.description) || null, status: safeStatus(row.status, ['ACTIVE','PAUSED','COMPLETED','ARCHIVED'], 'ACTIVE'), currency: string(row.currency, 'SAR'), reference_number: sourceId, notes: 'Imported from QuickBooks Online', amount: number(row.amount), transaction_payload: raw, created_by_id: userId, updated_by_id: userId }
  const existing = await createAdminClient().from('recurring_transaction_templates').select('id').eq('company_id', companyId).eq('template_name', templateName).is('deleted_at', null).maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data?.id) { const updated = await createAdminClient().from('recurring_transaction_templates').update(values).eq('id', existing.data.id); if (updated.error) throw updated.error; return { id: String(existing.data.id), table:'recurring_transaction_templates' } }
  const created = await createAdminClient().from('recurring_transaction_templates').insert(values).select('id').single(); if (created.error) throw created.error
  return { id: String(created.data.id), table:'recurring_transaction_templates' }
}

async function materializeFixedAsset(row: Row, companyId: string, _userId: string, realmId: string) {
  const raw = parseQuickBooksRaw(row); const sourceId = string(raw.Id ?? row.sourceId); const assetNo = string(row.code, `QB-${sourceId}`)
  const accountSourceId = string((raw.AssetAccountRef as Row | undefined)?.value ?? row.accountSourceId)
  const account = accountSourceId ? await resolveQuickBooksLocalId(companyId, realmId, accountSourceId, ['Account']) : null
  const values = { company_id: companyId, asset_no: assetNo, name: string(row.name, assetNo), purchase_date: date(raw.PurchaseDate ?? row.date), purchase_cost: number(raw.PurchaseCost ?? row.amount), salvage_value: number(raw.SalvageValue), useful_life_months: Math.max(1, number(raw.UsefulLifeInMonths, 60)), depreciation_method: string(raw.DepreciationMethod, 'STRAIGHT_LINE').toUpperCase(), accumulated_depreciation: number(raw.AccumulatedDepreciation), account_id: account?.id ?? null, status: safeStatus(row.status, ['ACTIVE','DISPOSED','INACTIVE'], 'ACTIVE') }
  const result = await createAdminClient().from('fixed_assets').upsert(values, { onConflict: 'company_id,asset_no' }).select('id').single(); if (result.error) throw result.error
  return { id: String(result.data.id), table:'fixed_assets' }
}

async function materializeAttachment(row: Row, companyId: string, userId: string, realmId: string) {
  const raw = parseQuickBooksRaw(row)
  const references = Array.isArray(raw.AttachableRef) ? raw.AttachableRef as Row[] : []
  const entityRef = references.map(reference => reference.EntityRef as Row | undefined).find(Boolean)
  const sourceId = string(entityRef?.value)
  const linked = sourceId ? await resolveQuickBooksLocalId(companyId, realmId, sourceId) : null
  let stored: Row = {}
  try { stored = JSON.parse(string(row._hisabAttachment, '{}')) as Row } catch { stored = {} }
  if (!linked || !stored.storagePath) return null
  const values = { company_id:companyId, entity_type:linked.table, entity_id:linked.id, file_name:string(stored.fileName, `quickbooks-${string(raw.Id)}`), file_path:string(stored.storagePath), mime_type:string(stored.mimeType, 'application/octet-stream'), uploaded_by_id:userId }
  const existing = await createAdminClient().from('documents').select('id').eq('company_id',companyId).eq('file_path',values.file_path).maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data?.id) {
    const updated = await createAdminClient().from('documents').update(values).eq('id',existing.data.id)
    if (updated.error) throw updated.error
    return { id:String(existing.data.id), table:'documents' }
  }
  const created = await createAdminClient().from('documents').insert(values).select('id').single()
  if (created.error) throw created.error
  return { id:String(created.data.id), table:'documents' }
}

async function materializeTimeActivity(row: Row, companyId: string, userId: string, realmId: string) {
  const raw = parseQuickBooksRaw(row); const sourceId = string(raw.Id ?? row.sourceId)
  const employeeSource = string((raw.EmployeeRef as Row | undefined)?.value)
  const vendorSource = string((raw.VendorRef as Row | undefined)?.value)
  const customerSource = string((raw.CustomerRef as Row | undefined)?.value)
  const itemSource = string((raw.ItemRef as Row | undefined)?.value)
  const employee = employeeSource ? await resolveQuickBooksLocalId(companyId,realmId,employeeSource,['Employee']) : null
  const vendor = vendorSource ? await resolveQuickBooksLocalId(companyId,realmId,vendorSource,['Vendor']) : null
  if (!employee && !vendor) return null
  const customer = customerSource ? await resolveQuickBooksLocalId(companyId,realmId,customerSource,['Customer'],['customers']) : null
  const project = customerSource ? await resolveQuickBooksLocalId(companyId,realmId,customerSource,['Customer'],['cost_centers']) : null
  const item = itemSource ? await resolveQuickBooksLocalId(companyId,realmId,itemSource,['Item']) : null
  const hours = Math.max(0.0001, number(raw.Hours) + number(raw.Minutes) / 60)
  const values = { company_id:companyId, activity_no:string(raw.DocNumber ?? row.code,`QB-${sourceId}`), activity_date:date(raw.TxnDate ?? row.date), employee_id:employee?.id ?? null, vendor_id:employee ? null : vendor?.id ?? null, customer_id:customer?.id ?? null, project_id:project?.table === 'cost_centers' ? project.id : null, service_item_id:item?.id ?? null, description:string(raw.Description ?? row.description,'Imported QuickBooks time activity'), hours, cost_rate:number(raw.CostRate), billing_rate:number(raw.HourlyRate), is_billable:string(raw.BillableStatus).toLowerCase() === 'billable', status:string(raw.BillableStatus).toLowerCase() === 'hasbeenbilled' ? 'INVOICED' : 'APPROVED', created_by_id:userId, deleted_at:bool(row._deleted,false) ? new Date().toISOString() : null }
  if (values.is_billable && !values.customer_id) return null
  const result = await createAdminClient().from('time_activities').upsert(values,{ onConflict:'company_id,activity_no' }).select('id').single(); if (result.error) throw result.error
  return { id:String(result.data.id), table:'time_activities' }
}

async function materializePreferences(row: Row, companyId: string) {
  const raw = parseQuickBooksRaw(row)
  const currencyPrefs = raw.CurrencyPrefs as Row | undefined
  const homeCurrency = currencyPrefs?.HomeCurrency as Row | undefined
  const accounting = raw.AccountingInfoPrefs as Row | undefined
  const monthNames = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER']
  const month = monthNames.indexOf(string(accounting?.FirstMonthOfFiscalYear).toUpperCase()) + 1
  const patch: Row = {}
  if (homeCurrency?.value) patch.currency = string(homeCurrency.value).toUpperCase()
  if (month > 0) patch.fiscal_year_start = `${String(month).padStart(2,'0')}-01`
  if (Object.keys(patch).length) { const updated = await createAdminClient().from('companies').update(patch).eq('id',companyId); if (updated.error) throw updated.error }
  if (patch.currency) {
    const currency = await createAdminClient().from('company_currencies').upsert({ company_id:companyId, code:patch.currency, name:patch.currency, is_primary:true, is_active:true }, { onConflict:'company_id,code' }).select('id').single(); if (currency.error) throw currency.error
  }
  return { id:companyId, table:'companies' }
}

async function materializeTaxCode(row:Row,companyId:string,_userId:string,realmId:string){
  const raw=parseQuickBooksRaw(row),sourceId=string(raw.Id??row.sourceId),name=string(raw.Name??row.name,`QuickBooks Tax Code ${sourceId}`)
  const group=await createAdminClient().from('tax_groups').upsert({company_id:companyId,name,description:`QuickBooks TaxCode ${sourceId}`,compound_method:'ADDITIVE',is_active:bool(raw.Active,true),deleted_at:bool(row._deleted,false)?new Date().toISOString():null},{onConflict:'company_id,name'}).select('id').single()
  if(group.error)throw group.error
  const groupId=String(group.data.id),lists=[raw.SalesTaxRateList,raw.PurchaseTaxRateList].filter(value=>value&&typeof value==='object') as Row[]
  const refs:string[]=[]
  for(const list of lists)for(const detail of (Array.isArray(list.TaxRateDetail)?list.TaxRateDetail:[]) as Row[]){const ref=detail.TaxRateRef as Row|undefined,id=string(ref?.value);if(id&&!refs.includes(id))refs.push(id)}
  const resolved:string[]=[]
  for(const ref of refs){const local=await resolveQuickBooksLocalId(companyId,realmId,ref,['TaxRate']);if(local?.table==='tax_rates')resolved.push(local.id)}
  if(refs.length!==resolved.length)return null
  const removed=await createAdminClient().from('tax_group_rates').delete().eq('company_id',companyId).eq('tax_group_id',groupId);if(removed.error)throw removed.error
  if(resolved.length){const inserted=await createAdminClient().from('tax_group_rates').insert(resolved.map((taxRateId,index)=>({company_id:companyId,tax_group_id:groupId,tax_rate_id:taxRateId,sequence:index+1})));if(inserted.error)throw inserted.error}
  return {id:groupId,table:'tax_groups'}
}

async function materializeTaxAgency(row:Row,companyId:string,_userId:string,realmId:string){
  const raw=parseQuickBooksRaw(row),sourceId=string(raw.Id??row.sourceId),name=string(raw.DisplayName??raw.Name??row.name,`QuickBooks Tax Agency ${sourceId}`)
  const accountRef=(raw.TaxLiabilityAccountRef??raw.LiabilityAccountRef??raw.AccountRef) as Row|undefined
  let liability=accountRef?.value?await resolveQuickBooksLocalId(companyId,realmId,string(accountRef.value),['Account'],['chart_of_accounts']):null
  if(!liability){const fallback=await createAdminClient().from('chart_of_accounts').select('id').eq('company_id',companyId).or('name.ilike.%tax%payable%,name.ilike.%vat%payable%,sub_type.ilike.%tax%payable%').is('deleted_at',null).limit(1).maybeSingle();if(fallback.error)throw fallback.error;if(fallback.data)liability={id:String(fallback.data.id),table:'chart_of_accounts'}}
  if(!liability)return null
  const code=string(row.code,`QB-${sourceId}`),values={name,registration_number:string(raw.TaxRegistrationNumber??raw.TaxIdentifier)||null,liability_account_id:liability.id,payment_terms_days:number(raw.PaymentTermsDays,0),is_active:bool(raw.Active,true),deleted_at:bool(row._deleted,false)?new Date().toISOString():null}
  const existing=await createAdminClient().from('tax_agencies').select('id').eq('company_id',companyId).eq('code',code).maybeSingle();if(existing.error)throw existing.error
  if(existing.data){const updated=await createAdminClient().from('tax_agencies').update(values).eq('company_id',companyId).eq('id',existing.data.id);if(updated.error)throw updated.error;return{id:String(existing.data.id),table:'tax_agencies'}}
  const created=await createAdminClient().from('tax_agencies').insert({company_id:companyId,code,...values}).select('id').single();if(created.error)throw created.error;return{id:String(created.data.id),table:'tax_agencies'}
}

async function materializeInventoryAdjustment(row:Row,companyId:string,userId:string,realmId:string) {
  const raw=parseQuickBooksRaw(row); const sourceId=string(raw.Id??row.sourceId)
  const archived=await findArchivedRecord(companyId,realmId,'InventoryAdjustment',sourceId)
  if(!archived) return null
  const existing=await createAdminClient().from('stock_movements').select('id').eq('company_id',companyId).eq('source_type','QUICKBOOKS_INVENTORY_ADJUSTMENT').eq('source_id',archived.id).limit(1)
  if(existing.error) throw existing.error
  if(existing.data?.[0]) return {id:String(existing.data[0].id),table:'stock_movements'}
  const lines=Array.isArray(raw.Line)?raw.Line as Row[]:[]
  let firstId:string|null=null
  for(const line of lines) {
    const detail=(line.ItemAdjustmentLineDetail??line.InventoryAdjustmentLineDetail??line.ItemBasedExpenseLineDetail??{}) as Row
    const itemRef=(detail.ItemRef??{}) as Row
    const itemSourceId=string(itemRef.value)
    const item=itemSourceId?await resolveQuickBooksLocalId(companyId,realmId,itemSourceId,['Item'],['inventory_items']):null
    const quantity=number(detail.QtyDiff??detail.QuantityDiff??line.Quantity)
    if(!item||Math.abs(quantity)<0.0001) continue
    const movement=await processInventoryMovement({companyId,userId,inventoryItemId:item.id,quantity,movementType:'ADJUSTMENT',unitCost:detail.UnitCost===undefined?undefined:number(detail.UnitCost),sourceType:'QUICKBOOKS_INVENTORY_ADJUSTMENT',sourceId:String(archived.id),reference:string(raw.DocNumber??raw.PrivateNote,`QuickBooks inventory adjustment ${sourceId}`),movementDate:new Date(string(raw.TxnDate??row.date)||Date.now()),postCogsJournal:false})
    firstId??=movement.movementId
    await postInventoryAdjustmentJournal({companyId,userId,sourceId:movement.movementId,varianceValue:(quantity<0?-1:1)*movement.totalCost,description:`QuickBooks inventory adjustment ${sourceId}`,entryDate:new Date(string(raw.TxnDate??row.date)||Date.now())})
  }
  return firstId?{id:firstId,table:'stock_movements'}:null
}

async function materializeTransfer(row:Row,companyId:string,userId:string,realmId:string) {
  const raw=parseQuickBooksRaw(row); const sourceId=string(raw.Id??row.sourceId)
  const fromRef=(raw.FromAccountRef??{}) as Row; const toRef=(raw.ToAccountRef??{}) as Row
  const fromCoa=await resolveQuickBooksLocalId(companyId,realmId,string(fromRef.value),['Account'],['chart_of_accounts'])
  const toCoa=await resolveQuickBooksLocalId(companyId,realmId,string(toRef.value),['Account'],['chart_of_accounts'])
  if(!fromCoa||!toCoa) return null
  const banks=await createAdminClient().from('bank_accounts').select('id,account_id').eq('company_id',companyId).in('account_id',[fromCoa.id,toCoa.id]).is('deleted_at',null)
  if(banks.error) throw banks.error
  const from=banks.data?.find(account=>account.account_id===fromCoa.id); const to=banks.data?.find(account=>account.account_id===toCoa.id)
  if(!from||!to) return null
  const result=await createBankTransfer({companyId,userId,transferNo:string(raw.DocNumber,`QB-XFER-${sourceId}`),fromAccountId:String(from.id),toAccountId:String(to.id),date:new Date(string(raw.TxnDate??row.date)||Date.now()),amount:number(raw.Amount??row.amount),reference:string(raw.PrivateNote??raw.DocNumber)||null})
  return {id:result.id,table:'bank_transfers'}
}

async function materializeCreditMemo(row:Row,companyId:string,userId:string,realmId:string) {
  const raw=parseQuickBooksRaw(row); const sourceId=string(raw.Id??row.sourceId)
  const linked=[...(Array.isArray(raw.LinkedTxn)?raw.LinkedTxn as Row[]:[]),...(Array.isArray(raw.Line)?(raw.Line as Row[]).flatMap(line=>Array.isArray(line.LinkedTxn)?line.LinkedTxn as Row[]:[]):[])]
  const invoiceLink=linked.find(link=>string(link.TxnType).toLowerCase()==='invoice')
  const sourceInvoice=invoiceLink?await resolveQuickBooksLocalId(companyId,realmId,string(invoiceLink.TxnId),['Invoice'],['invoices']):null
  const customerRef=(raw.CustomerRef??{}) as Row,customer=customerRef.value?await resolveQuickBooksCustomerContext(companyId,realmId,string(customerRef.value)):null
  if(!sourceInvoice&&!customer)throw new Error(`QuickBooks customer ${string(customerRef.value)} must be migrated before Credit Memo ${sourceId}.`)
  const nativeLines=[]
  for(const line of Array.isArray(raw.Line)?raw.Line as Row[]:[]) {
    if(string(line.DetailType)==='SubTotalLineDetail')continue
    const detail=(line.SalesItemLineDetail??{}) as Row; const itemRef=(detail.ItemRef??{}) as Row; const accountRef=(detail.AccountRef??detail.ItemAccountRef??{}) as Row; const classRef=(detail.ClassRef??{}) as Row
    const item=itemRef.value?await resolveQuickBooksInventoryItemId(companyId,realmId,string(itemRef.value)):null
    const account=accountRef.value?await resolveQuickBooksLocalId(companyId,realmId,string(accountRef.value),['Account'],['chart_of_accounts']):null
    const costCenter=classRef.value?await resolveQuickBooksLocalId(companyId,realmId,string(classRef.value),['Class'],['cost_centers']):null
    const quantity=Math.max(0.0001,number(detail.Qty,1)); const amount=number(line.Amount); const unitPrice=number(detail.UnitPrice,amount/quantity)
    nativeLines.push({description:string(line.Description,'Imported QuickBooks credit memo line'),quantity,unitPrice,taxRate:0,accountId:account?.id??null,costCenterId:costCenter?.id??null,inventoryItemId:item?.id??null})
  }
  if(!nativeLines.length) return null
  const date=new Date(string(raw.TxnDate??row.date)||Date.now()),currency=string((raw.CurrencyRef as Row|undefined)?.value,'SAR')
  const created=sourceInvoice
    ?await getInvoiceRepository().createAdjustment({companyId,documentNo:string(raw.DocNumber,`QB-CM-${sourceId}`),legacyId:sourceId,status:'SENT',sourceInvoiceId:sourceInvoice.id,adjustmentType:'CREDIT_NOTE',date,dueDate:date,lines:nativeLines,notes:string(raw.PrivateNote??row.description)||null,createdById:userId})
    :await getInvoiceRepository().create({companyId,documentNo:string(raw.DocNumber,`QB-CM-${sourceId}`),legacyId:sourceId,status:'SENT',customerId:customer!.customerId,date,dueDate:date,currency,lines:nativeLines,notes:string(raw.PrivateNote??row.description)||null,createdById:userId})
  if(!sourceInvoice){const total=number(raw.TotalAmt),balance=number(raw.RemainingCredit??raw.Balance,total),updated=await createAdminClient().from('invoices').update({invoice_type:'CREDIT_NOTE',balance,amount_paid:Math.max(0,total-balance)}).eq('company_id',companyId).eq('id',created.id);if(updated.error)throw updated.error}
  await postInvoiceToLedger(created.id,companyId)
  return {id:created.id,table:'invoices'}
}

async function materializeBillPayment(row:Row,companyId:string,_userId:string,realmId:string){
  const raw=parseQuickBooksRaw(row),sourceId=string(raw.Id??row.sourceId),relationships=extractQuickBooksPaymentRelationships(raw,'VENDOR')
  if(relationships.issues.length)throw new Error(`QuickBooks bill-payment relationships are not certifiable: ${relationships.issues.join(' ')}`)
  const vendorRef=(raw.VendorRef??{}) as Row,vendor=vendorRef.value?await resolveQuickBooksLocalId(companyId,realmId,string(vendorRef.value),['Vendor'],['vendors']):null
  if(!vendor)throw new Error(`QuickBooks vendor ${string(vendorRef.value)} must be migrated before bill payment ${sourceId}.`)
  const currency=string((raw.CurrencyRef as Row|undefined)?.value,'SAR'),exchangeRate=number(raw.ExchangeRate,1),resolved=await resolveQuickBooksPaymentAllocations({companyId,realmId,sourcePaymentId:sourceId,kind:'VENDOR',currency,exchangeRate,allocations:relationships.allocations}),db=createAdminClient()
  const existing=await db.from('payments').select('id,amount').eq('company_id',companyId).eq('legacy_id',sourceId).is('deleted_at',null).limit(1).maybeSingle();if(existing.error)throw existing.error
  if(existing.data&&Math.abs(Number(existing.data.amount)-relationships.paymentAmount)>0.0001)throw new Error(`Posted QuickBooks bill payment ${sourceId} changed amount; resolve the synchronization conflict.`)
  let paymentId=existing.data?String(existing.data.id):''
  if(!paymentId){const created=await db.from('payments').insert({company_id:companyId,legacy_id:sourceId,payment_no:string(raw.DocNumber,`QB-BP-${sourceId}`),date:new Date(string(raw.TxnDate)||Date.now()).toISOString(),amount:relationships.paymentAmount,exchange_rate:exchangeRate,base_amount:number(raw.HomeTotalAmt,relationships.paymentAmount*exchangeRate),method:string((raw.PayType??raw.PaymentType),'BANK_TRANSFER'),reference:string(raw.PrivateNote??raw.DocNumber)||null,vendor_id:vendor.id}).select('id').single();if(created.error)throw created.error;paymentId=String(created.data.id)}
  await replacePaymentAllocations(companyId,paymentId,resolved);await postPaymentToLedger(paymentId,companyId,currency);return {id:paymentId,table:'payments'}
}

async function materializeDeposit(row:Row,companyId:string,userId:string,realmId:string) {
  const raw=parseQuickBooksRaw(row); const sourceId=string(raw.Id??row.sourceId); const archived=await findArchivedRecord(companyId,realmId,'Deposit',sourceId)
  if(!archived) throw new Error(`QuickBooks deposit ${sourceId} was not archived before materialization.`)
  const relationships=extractQuickBooksDepositRelationships(raw)
  if(relationships.issues.length)throw new Error(`QuickBooks deposit ${sourceId} is not certifiable: ${relationships.issues.join(' ')}`)
  const depositRef=(raw.DepositToAccountRef??{}) as Row; const coa=depositRef.value?await resolveQuickBooksLocalId(companyId,realmId,string(depositRef.value),['Account'],['chart_of_accounts']):null
  if(!coa) throw new Error(`QuickBooks destination account ${string(depositRef.value)} must be migrated before deposit ${sourceId}.`)
  const db=createAdminClient();const bank=await db.from('bank_accounts').select('id').eq('company_id',companyId).eq('account_id',coa.id).is('deleted_at',null).maybeSingle(); if(bank.error) throw bank.error
  let bankId=bank.data?.id?String(bank.data.id):''
  if(!bankId){const sourceAccount=await db.from('quickbooks_migration_records').select('source_payload').eq('company_id',companyId).eq('realm_id',realmId).eq('entity_type','Account').eq('source_id',string(depositRef.value)).maybeSingle();if(sourceAccount.error)throw sourceAccount.error;const accountPayload=(sourceAccount.data?.source_payload??{}) as Row,accountType=string(accountPayload.AccountType);if(!['Bank','Other Current Asset'].includes(accountType))throw new Error(`QuickBooks deposit destination ${string(depositRef.value)} is not a supported bank or current-asset account.`);const bankCurrency=string((accountPayload.CurrencyRef as Row|undefined)?.value)||string((raw.CurrencyRef as Row|undefined)?.value,'SAR'),created=await db.from('bank_accounts').insert({company_id:companyId,account_id:coa.id,name:string(accountPayload.Name??accountPayload.FullyQualifiedName,`QuickBooks bank ${depositRef.value}`),account_number:string(accountPayload.AcctNum)||null,bank_name:'QuickBooks',currency:bankCurrency,opening_balance:0,current_balance:0,account_type:accountType==='Bank'?'BANK':'CURRENT_ASSET',is_active:accountPayload.Active!==false}).select('id').single();if(created.error)throw created.error;bankId=String(created.data.id)}
  const currency=string((raw.CurrencyRef as Row|undefined)?.value,'SAR').toUpperCase(),exchangeRate=number(raw.ExchangeRate,1),offsetLines:Parameters<typeof createBankDeposit>[0]['offsetLines']=[],allocations:NonNullable<Parameters<typeof createBankDeposit>[0]['allocations']>=[]
  for(const allocation of relationships.allocations) {
    const transactionType=allocation.sourceTransactionType.toLowerCase()
    const paymentLink=transactionType==='payment'&&allocation.sourceTransactionId?await resolveQuickBooksLocalId(companyId,realmId,allocation.sourceTransactionId,['Payment'],['payments']):null
    if(allocation.sourceTransactionType.toLowerCase()==='payment'&&!paymentLink)throw new Error(`QuickBooks payment ${allocation.sourceTransactionId} must be migrated before deposit ${sourceId}.`)
    const salesReceiptLink=transactionType==='salesreceipt'&&allocation.sourceTransactionId?await resolveQuickBooksLocalId(companyId,realmId,allocation.sourceTransactionId,['SalesReceipt'],['sales_receipts']):null
    if(transactionType==='salesreceipt'&&!salesReceiptLink)throw new Error(`QuickBooks Sales Receipt ${allocation.sourceTransactionId} must be migrated before deposit ${sourceId}.`)
    const payment=paymentLink?await createAdminClient().from('payments').select('deposit_account_id,exchange_rate').eq('company_id',companyId).eq('id',paymentLink.id).maybeSingle():null
    if(payment?.error)throw payment.error
    const salesReceipt=salesReceiptLink?await createAdminClient().from('sales_receipts').select('deposit_account_id,exchange_rate').eq('company_id',companyId).eq('id',salesReceiptLink.id).maybeSingle():null
    if(salesReceipt?.error)throw salesReceipt.error
    const accountLink=allocation.sourceAccountId?await resolveQuickBooksLocalId(companyId,realmId,allocation.sourceAccountId,['Account'],['chart_of_accounts']):null
    const accountId=String(accountLink?.id??payment?.data?.deposit_account_id??salesReceipt?.data?.deposit_account_id??'')
    if(!accountId)throw new Error(`Deposit ${sourceId} line ${allocation.sourceLineKey} has no migrated source or Undeposited Funds account.`)
    const amount=Math.abs(allocation.amount),description=allocation.description||`QuickBooks deposit ${sourceId} source`
    offsetLines.push(allocation.amount>0?{accountId,credit:amount,description,exchangeRateOverride:exchangeRate}:{accountId,debit:amount,description,exchangeRateOverride:exchangeRate})
    allocations.push({paymentId:paymentLink?.id??null,accountId,amount:allocation.amount,currency,exchangeRate:Number(payment?.data?.exchange_rate??salesReceipt?.data?.exchange_rate??exchangeRate),sourceDepositId:sourceId,sourceLineKey:allocation.sourceLineKey,sourceTransactionType:allocation.sourceTransactionType,sourceTransactionId:allocation.sourceTransactionId,sourceAccountId:allocation.sourceAccountId,sourceEntityId:allocation.sourceEntityId,metadata:{...allocation.metadata,description:allocation.description,localSalesReceiptId:salesReceiptLink?.id??null}})
  }
  const payloadHash=createHash('sha256').update(stable(raw)).digest('hex')
  const transaction=await createBankDeposit({companyId,userId,sourceId,bankAccountId:bankId,date:new Date(string(raw.TxnDate??row.date)||Date.now()),amount:relationships.total,reference:string(raw.DocNumber)||null,description:string(raw.PrivateNote,`QuickBooks deposit ${sourceId}`),offsetLines,currency,exchangeRate,allocations,externalAccountSourceId:string(depositRef.value)||null,sourcePayloadHash:payloadHash})
  return {id:String(transaction.id),table:'bank_transactions'}
}

const configs: ExtendedConfig[] = [
  { key:'qb-projects', displayName:'QuickBooks Projects', entityType:'Customer', materialize:(r,c,u,realm)=>materializeCostCenter(r,c,u,realm,'PROJECT') },
  { key:'qb-budgets', displayName:'QuickBooks Budgets', entityType:'Budget', materialize:materializeBudget },
  { key:'qb-exchange-rates', displayName:'QuickBooks Exchange Rates', entityType:'ExchangeRate', materialize:materializeExchangeRate },
  { key:'qb-classes', displayName:'QuickBooks Classes', entityType:'Class', materialize:(r,c,u,realm)=>materializeCostCenter(r,c,u,realm,'CLASS') },
  { key:'qb-departments', displayName:'QuickBooks Departments', entityType:'Department', materialize:materializeDepartment },
  { key:'qb-locations', displayName:'QuickBooks Locations', entityType:'Department', materialize:(r,c,u,realm)=>materializeCostCenter(r,c,u,realm,'LOCATION') },
  { key:'qb-employees', displayName:'QuickBooks Employees', entityType:'Employee', materialize:materializeEmployee },
  { key:'qb-time-activities', displayName:'QuickBooks Time Activities', entityType:'TimeActivity', materialize:materializeTimeActivity },
  { key:'qb-credit-memos', displayName:'QuickBooks Credit Memos', entityType:'CreditMemo', materialize:materializeCreditMemo },
  { key:'qb-bill-payments', displayName:'QuickBooks Bill Payments', entityType:'BillPayment', materialize:materializeBillPayment },
  { key:'qb-deposits', displayName:'QuickBooks Deposits', entityType:'Deposit', materialize:materializeDeposit },
  { key:'qb-transfers', displayName:'QuickBooks Transfers', entityType:'Transfer', materialize:materializeTransfer },
  { key:'qb-inventory-adjustments', displayName:'QuickBooks Inventory Adjustments', entityType:'InventoryAdjustment', materialize:materializeInventoryAdjustment },
  { key:'qb-attachments', displayName:'QuickBooks Attachments', entityType:'Attachable', materialize:materializeAttachment },
  { key:'qb-recurring-transactions', displayName:'QuickBooks Recurring Transactions', entityType:'RecurringTransaction', materialize:materializeRecurring },
  { key:'qb-tax-agencies', displayName:'QuickBooks Tax Agencies', entityType:'TaxAgency', materialize:materializeTaxAgency },
  { key:'qb-tax-configurations', displayName:'QuickBooks Tax Configuration', entityType:'TaxCode', materialize:materializeTaxCode },
  { key:'qb-preferences', displayName:'QuickBooks Company Preferences', entityType:'Preferences', materialize:materializePreferences },
  { key:'qb-fixed-assets', displayName:'QuickBooks Fixed Assets', entityType:'Item', materialize:materializeFixedAsset },
]

function moduleFor(config: ExtendedConfig): ModuleDefinition {
  return {
    key: config.key, displayName: config.displayName, fields, duplicateKeys: ['sourceId'],
    parseImportRow: row => row,
    async findDuplicate(row, ctx) {
      const realmId = string(row._realmId); const sourceId = string(row.sourceId ?? row._quickbooksId)
      if (!realmId || !sourceId) return null
      const linked=await resolveQuickBooksLocalId(ctx.companyId,realmId,sourceId,[config.entityType])
      return linked ? { id: linked.id, matchedOn:['sourceId'] } : null
    },
    async createRecord(row, ctx) {
      const realmId = string(row._realmId); const sourceId = string(row.sourceId ?? row._quickbooksId)
      if (!realmId) throw new Error('QuickBooks realm ID is required')
      const archived = await archiveQuickBooksRecord({ companyId:ctx.companyId, realmId, entityType:config.entityType, row })
      const local = config.materialize ? await config.materialize(row, ctx.companyId, ctx.userId, realmId) : null
      if (local) {
        await linkArchivedQuickBooksRecord({ companyId:ctx.companyId, realmId, entityType:config.entityType, sourceId, localTable:local.table, localId:local.id })
        await materializeQuickBooksCustomFields({ companyId:ctx.companyId, entityType:local.table, entityId:local.id, row })
      }
      else await recordQuickBooksWarning({ companyId:ctx.companyId, realmId, resourceKey:config.key, sourceId, code:config.materialize?'NATIVE_MATERIALIZATION_BLOCKED':'LOSSLESS_ARCHIVE_ONLY', message:config.materialize?`${config.displayName} could not be materialized because a required native relationship or account is missing.`:`${config.displayName} was preserved losslessly but requires an existing posting-safe product workflow before materialization.`, details:{ entityType:config.entityType } })
      // `local` is null for two distinct, both-legitimate reasons: the module has
      // no materializer at all (LOSSLESS_ARCHIVE_ONLY), or its materializer ran
      // and found nothing that warrants a native row (NATIVE_MATERIALIZATION_BLOCKED —
      // e.g. every line of a QuickBooks InventoryAdjustment was a zero-quantity
      // no-op). Either way there is no native id to link, so the caller must
      // treat this as an intentional skip, not a failed native creation.
      return { id: local?.id ?? String(archived.id), archiveOnly: !local }
    },
    async updateRecord(_id, row, ctx) { await this.createRecord!(row, ctx) },
    async exportRecords(_filters, ctx) {
      const result = await createAdminClient().from('quickbooks_migration_records').select('source_payload').eq('company_id',ctx.companyId).eq('entity_type',config.entityType).order('source_updated_at',{ascending:true})
      if (result.error) throw result.error
      return (result.data ?? []).map(item => item.source_payload)
    },
    mapExportRow(record) { const raw = record as Row; return { sourceId:string(raw.Id), name:string(raw.DisplayName ?? raw.Name), code:string(raw.DocNumber ?? raw.AcctNum), status:string(raw.Status ?? raw.TxnStatus), _quickbooksRaw:JSON.stringify(raw) } },
  }
}

export const quickBooksExtendedModules = configs.map(moduleFor)
