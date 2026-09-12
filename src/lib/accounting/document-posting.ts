import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getCurrencyRoles, getCurrencySettings } from '@/lib/currency/fx-accounts'
import { getExchangeRateAtDate } from '@/lib/currency/exchange-rates'
import { computeRealizedFxDifference } from '@/lib/currency/fx-conversion'
import { postGoodsReceiptFromBill, postGoodsIssueFromInvoice, postGoodsIssueFromSalesReceipt, postGoodsReturnFromCreditNote, postGoodsReturnToVendorFromCredit } from '@/lib/inventory/document-hooks'
import { buildTaxJournalLines } from '@/lib/tax/journal-posting'
import { findSystemAccount, findSystemAccountByNameCandidates, postSourceDocumentToLedger } from './posting-service'
import type { PostingLine } from './posting-service'

function roundMoney(v: number) { return Math.round(v * 10000) / 10000 }

async function getAccountIds(companyId: string) {
  const ar = await findSystemAccount(companyId, { nameContains: 'Receivable', canonicalType: 'Asset' })
  const ap = await findSystemAccount(companyId, { nameContains: 'Payable', canonicalType: 'Liability' })
  const revenue = await findSystemAccount(companyId, { accountNoPrefix: '41', canonicalType: 'Income' })
  const vatPayable = await findSystemAccountByNameCandidates(companyId, ['VAT Payable', 'Output VAT', 'Sales Tax Payable'], { canonicalType: 'Liability' })
  const vatReceivable = await findSystemAccountByNameCandidates(companyId, ['VAT Receivable', 'Input VAT', 'Input Tax'], { canonicalType: 'Asset' })
  const bank = await findSystemAccount(companyId, { accountNoPrefix: '11-1101' })
  const expense = await findSystemAccount(companyId, { accountNoPrefix: '61' })
  const salaries = await findSystemAccount(companyId, { nameContains: 'Salaries' })
  return { ar, ap, revenue, vatPayable, vatReceivable, bank, expense, salaries }
}

async function storeDocumentBaseAmounts(
  table: 'invoices' | 'bills' | 'vendor_credits' | 'sales_receipts',
  id: string,
  companyId: string,
  currency: string,
  entryDate: Date,
  subtotal: number,
  taxAmount: number,
  total: number,
  rateOverride?: number | null,
) {
  const roles = await getCurrencyRoles(companyId)
  const rate = rateOverride && rateOverride > 0 ? rateOverride : await getExchangeRateAtDate(currency, roles.baseCurrency, entryDate, companyId)
  const client = createAdminClient()
  const updated = await client
    .from(table)
    .update({
      exchange_rate: rate,
      base_subtotal: subtotal * rate,
      base_tax_amount: taxAmount * rate,
      base_total: total * rate,
    })
    .eq('id', id)
    .eq('company_id', companyId)
  if(updated.error)throw updated.error
  return rate
}

export async function postInvoiceToLedger(invoiceId: string, companyId?: string) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const accounts = await getAccountIds(cid)

  const { data: invoice, error } = await client
    .from('invoices')
    .select('*, lines:invoice_lines(*)')
    .eq('id', invoiceId)
    .eq('company_id', cid)
    .single()

  if (error || !invoice) throw new Error('Invoice not found')
  if (!['SENT', 'PAID', 'PARTIAL'].includes(String(invoice.status))) return

  const currency = String(invoice.currency ?? 'SAR')
  const entryDate = new Date(String(invoice.date))
  const subtotal = Number(invoice.subtotal)
  const taxAmount = Number(invoice.tax_amount)
  const total = Number(invoice.total)

  const exchangeRate = await storeDocumentBaseAmounts(
    'invoices', invoiceId, cid, currency, entryDate, subtotal, taxAmount, total, Number(invoice.exchange_rate) || null,
  )

  const lines: PostingLine[] = []
  const arAccount = accounts.ar
  const revenueAccount = accounts.revenue
  const isCreditNote = String(invoice.invoice_type) === 'CREDIT_NOTE'

  if (arAccount && total > 0) {
    lines.push({
      accountId: arAccount,
      debit: isCreditNote ? undefined : total,
      credit: isCreditNote ? total : undefined,
      description: `Invoice ${invoice.invoice_no}`,
      exchangeRateOverride: exchangeRate,
    })
  }
  const revenueLines = (invoice.lines ?? []).filter((line: Record<string,unknown>) => Number(line.amount ?? 0) > 0)
  if (revenueLines.length) {
    for (const line of revenueLines) {
      const accountId = line.account_id ? String(line.account_id) : revenueAccount
      if (!accountId) continue
      lines.push({ accountId, debit:isCreditNote?Number(line.amount):undefined, credit:isCreditNote?undefined:Number(line.amount), description:String(line.description ?? `Revenue ${invoice.invoice_no}`), costCenterId:line.cost_center_id ? String(line.cost_center_id) : null, exchangeRateOverride:exchangeRate })
    }
  } else if (revenueAccount && subtotal > 0) {
    lines.push({ accountId:revenueAccount, debit:isCreditNote?subtotal:undefined, credit:isCreditNote?undefined:subtotal, description:`Revenue ${invoice.invoice_no}`, exchangeRateOverride:exchangeRate })
  }

  const taxComponents = taxAmount > 0
    ? [{
        name: 'VAT',
        rate: subtotal > 0 ? roundMoney((taxAmount / subtotal) * 100) : 15,
        taxMode: 'EXCLUSIVE' as const,
        taxableAmount: subtotal,
        taxAmount,
        isReverseCharge: false,
        isWithholding: false,
      }]
    : []

  const taxLines = await buildTaxJournalLines({
    companyId: cid,
    documentNo: String(invoice.invoice_no),
    documentType: 'INVOICE',
    isSales: true,
    components: taxComponents,
  })
  for (const tl of taxLines) {
    lines.push({ ...tl, debit:isCreditNote?tl.credit:tl.debit, credit:isCreditNote?tl.debit:tl.credit, exchangeRateOverride: exchangeRate })
  }

  if (lines.length >= 2) {
    await postSourceDocumentToLedger({
      companyId: cid,
      sourceType: 'INVOICE',
      sourceId: invoiceId,
      entryDate,
      description: `Invoice ${invoice.invoice_no}`,
      currency,
      lines,
    })
    if(isCreditNote) await postGoodsReturnFromCreditNote(invoiceId,cid)
    else await postGoodsIssueFromInvoice(invoiceId, cid)
  }
}

export async function postBillToLedger(billId: string, companyId?: string, sourceCurrency?: string) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const accounts = await getAccountIds(cid)

  const { data: bill, error } = await client
    .from('bills')
    .select('*, lines:bill_lines(*)')
    .eq('id', billId)
    .eq('company_id', cid)
    .single()

  if (error || !bill) throw new Error('Bill not found')
  if (!['RECEIVED', 'PAID', 'PARTIAL'].includes(String(bill.status))) return

  const currency = sourceCurrency || (await getCurrencyRoles(cid)).baseCurrency
  const entryDate = new Date(String(bill.date))
  const subtotal = Number(bill.subtotal)
  const taxAmount = Number(bill.tax_amount)
  const total = Number(bill.total)

  const exchangeRate = await storeDocumentBaseAmounts(
    'bills', billId, cid, currency, entryDate, subtotal, taxAmount, total, Number(bill.exchange_rate) || null,
  )

  const lines: PostingLine[] = []
  const expenseAccount = accounts.expense
  const apAccount = accounts.ap

  const purchaseLines = (bill.lines ?? []).filter((line: Record<string,unknown>) => Number(line.amount ?? 0) > 0)
  if (purchaseLines.length) {
    for (const line of purchaseLines) {
      const accountId = line.account_id ? String(line.account_id) : expenseAccount
      if (!accountId) continue
      // A QuickBooks bill can carry an in-document reduction line (e.g. a
      // negative AccountBasedExpenseLineDetail amount) against the same
      // account. `bill_lines.amount` stores the magnitude (non-negative
      // constraint); `is_reduction` records that it posts as a credit
      // (reducing the account) rather than a debit, so the entry still
      // balances against the QuickBooks-reported (already-net) bill total.
      const isReduction = Boolean(line.is_reduction)
      lines.push({
        accountId,
        debit: isReduction ? undefined : Number(line.amount),
        credit: isReduction ? Number(line.amount) : undefined,
        description: String(line.description ?? `Bill ${bill.bill_no}`),
        costCenterId: line.cost_center_id ? String(line.cost_center_id) : null,
        exchangeRateOverride: exchangeRate,
      })
    }
  } else if (expenseAccount && subtotal > 0) {
    lines.push({ accountId:expenseAccount, debit:subtotal, description:`Bill ${bill.bill_no}`, exchangeRateOverride:exchangeRate })
  }

  if (taxAmount > 0) {
    const taxLines = await buildTaxJournalLines({
      companyId: cid,
      documentNo: String(bill.bill_no),
      documentType: 'BILL',
      isSales: false,
      components: [{
        name: 'VAT',
        rate: subtotal > 0 ? roundMoney((taxAmount / subtotal) * 100) : 15,
        taxMode: 'EXCLUSIVE',
        taxableAmount: subtotal,
        taxAmount,
        isReverseCharge: false,
        isWithholding: false,
      }],
    })
    for (const tl of taxLines) {
      lines.push({ ...tl, exchangeRateOverride: exchangeRate })
    }
  }

  if (apAccount && total > 0) {
    lines.push({
      accountId: apAccount,
      credit: total,
      description: `Bill ${bill.bill_no}`,
      exchangeRateOverride: exchangeRate,
    })
  }

  if (lines.length >= 2) {
    await postSourceDocumentToLedger({
      companyId: cid,
      sourceType: 'BILL',
      sourceId: billId,
      entryDate,
      description: `Bill ${bill.bill_no}`,
      currency,
      lines,
    })
    await postGoodsReceiptFromBill(billId, cid)
  }
}

export async function postPaymentToLedger(paymentId: string, companyId?: string, sourceCurrency?: string) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const accounts = await getAccountIds(cid)
  const fxSettings = await getCurrencySettings(cid)

  const { data: payment, error } = await client
    .from('payments')
    .select('*')
    .eq('id', paymentId)
    .eq('company_id', cid)
    .single()

  if (error || !payment) throw new Error('Payment not found')

  const currency = sourceCurrency || (await getCurrencyRoles(cid)).baseCurrency
  const entryDate = new Date(String(payment.date))
  const amount = Number(payment.amount)
  const roles = await getCurrencyRoles(cid)
  const paymentRate = Number(payment.exchange_rate)>0?Number(payment.exchange_rate):await getExchangeRateAtDate(currency, roles.baseCurrency, entryDate, cid)

  await client
    .from('payments')
    .update({
      exchange_rate: paymentRate,
      base_amount: amount * paymentRate,
    })
    .eq('id', paymentId)
    .eq('company_id', cid)

  const lines: PostingLine[] = []
  const realizedLines: PostingLine[] = []
  let settlementAccount = accounts.bank
  const allocationResult=await client.from('payment_allocations').select('invoice_id,bill_id,cash_amount,source_target_id').eq('company_id',cid).eq('payment_id',paymentId)
  if(allocationResult.error)throw allocationResult.error
  const allocations=allocationResult.data??[]
  const invoiceIds=allocations.map(item=>item.invoice_id).filter(Boolean) as string[],billIds=allocations.map(item=>item.bill_id).filter(Boolean) as string[]
  const invoiceResult=invoiceIds.length?await client.from('invoices').select('id,exchange_rate,invoice_no').eq('company_id',cid).in('id',invoiceIds):{data:[],error:null}
  const billResult=billIds.length?await client.from('bills').select('id,exchange_rate,bill_no').eq('company_id',cid).in('id',billIds):{data:[],error:null}
  if(invoiceResult.error)throw invoiceResult.error;if(billResult.error)throw billResult.error
  const documents=new Map<string,{exchange_rate:unknown}>();for(const item of invoiceResult.data??[])documents.set(String(item.id),item);for(const item of billResult.data??[])documents.set(String(item.id),item)
  const customerPayment=invoiceIds.length>0||Boolean(payment.customer_id)||Boolean(payment.invoice_id)
  const vendorPayment=billIds.length>0||Boolean(payment.vendor_id)||Boolean(payment.bill_id)
  if(customerPayment===vendorPayment)throw new Error('Payment must belong to exactly one customer or vendor subledger.')
  if(customerPayment&&payment.deposit_account_id)settlementAccount=String(payment.deposit_account_id)
  else if(payment.bank_account_id){const linkedBank=await client.from('bank_accounts').select('account_id').eq('company_id',cid).eq('id',payment.bank_account_id).is('deleted_at',null).maybeSingle();if(linkedBank.error)throw linkedBank.error;if(linkedBank.data?.account_id)settlementAccount=String(linkedBank.data.account_id)}
  if(!settlementAccount)throw new Error(customerPayment?'A bank or Undeposited Funds account is required to post a customer payment.':'A bank account is required to post a vendor payment.')
  const controlAccount=customerPayment?accounts.ar:accounts.ap
  if(!controlAccount)throw new Error(customerPayment?'Accounts Receivable account is required.':'Accounts Payable account is required.')
  lines.push({accountId:settlementAccount,debit:customerPayment?amount:undefined,credit:vendorPayment?amount:undefined,description:`Payment ${payment.payment_no}`,exchangeRateOverride:paymentRate})
  lines.push({accountId:controlAccount,debit:vendorPayment?amount:undefined,credit:customerPayment?amount:undefined,description:`Payment ${payment.payment_no}`,exchangeRateOverride:paymentRate})

  if(currency!==roles.baseCurrency){
    const gainAccount=fxSettings?.realizedGainAccountId??await findSystemAccount(cid,{nameContains:'Realized FX Gain'})
    const lossAccount=fxSettings?.realizedLossAccountId??await findSystemAccount(cid,{nameContains:'Realized FX Loss'})
    for(const allocation of allocations){const cashAmount=Number(allocation.cash_amount??0),document=documents.get(String(allocation.invoice_id??allocation.bill_id??'')),documentRate=Number(document?.exchange_rate??0);if(cashAmount<=0||documentRate<=0)continue;const fxDiff=computeRealizedFxDifference({transactionAmount:cashAmount,originalRate:documentRate,settlementRate:paymentRate});if(Math.abs(fxDiff)<=0.01)continue
      if(customerPayment&&fxDiff>0){if(!gainAccount)throw new Error('Realized FX gain account is required.');realizedLines.push({accountId:controlAccount,debit:fxDiff,description:`Realized FX settlement ${payment.payment_no}`},{accountId:gainAccount,credit:fxDiff,description:`Realized FX gain ${payment.payment_no}`})}
      else if(customerPayment){if(!lossAccount)throw new Error('Realized FX loss account is required.');realizedLines.push({accountId:lossAccount,debit:Math.abs(fxDiff),description:`Realized FX loss ${payment.payment_no}`},{accountId:controlAccount,credit:Math.abs(fxDiff),description:`Realized FX settlement ${payment.payment_no}`})}
      else if(fxDiff>0){if(!lossAccount)throw new Error('Realized FX loss account is required.');realizedLines.push({accountId:lossAccount,debit:fxDiff,description:`Realized FX loss ${payment.payment_no}`},{accountId:controlAccount,credit:fxDiff,description:`Realized FX settlement ${payment.payment_no}`})}
      else{if(!gainAccount)throw new Error('Realized FX gain account is required.');realizedLines.push({accountId:controlAccount,debit:Math.abs(fxDiff),description:`Realized FX settlement ${payment.payment_no}`},{accountId:gainAccount,credit:Math.abs(fxDiff),description:`Realized FX gain ${payment.payment_no}`})}
    }
  }

  if (lines.length >= 2) {
    await postSourceDocumentToLedger({
      companyId: cid,
      sourceType: 'PAYMENT',
      sourceId: paymentId,
      entryDate,
      description: `Payment ${payment.payment_no}`,
      currency,
      lines,
    })
  }
  if(realizedLines.length>=2){await postSourceDocumentToLedger({companyId:cid,sourceType:'REALIZED_FX',sourceId:paymentId,entryDate,description:`Realized FX ${payment.payment_no}`,currency:roles.baseCurrency,lines:realizedLines})}
}

export async function postVendorCreditToLedger(vendorCreditId:string,companyId?:string) {
  const cid=companyId??await resolveCompanyId(),client=createAdminClient(),accounts=await getAccountIds(cid),credit=await client.from('vendor_credits').select('*, lines:vendor_credit_lines(*, item:inventory_items(inventory_asset_account_id))').eq('company_id',cid).eq('id',vendorCreditId).is('deleted_at',null).single()
  if(credit.error||!credit.data)throw new Error('Vendor Credit not found')
  const document=credit.data,currency=String(document.currency??'SAR'),entryDate=new Date(String(document.date)),subtotal=Number(document.subtotal),taxAmount=Number(document.tax_amount),total=Number(document.total),exchangeRate=await storeDocumentBaseAmounts('vendor_credits',vendorCreditId,cid,currency,entryDate,subtotal,taxAmount,total,Number(document.exchange_rate)||null),apAccount=document.ap_account_id?String(document.ap_account_id):accounts.ap
  if(!apAccount)throw new Error('Accounts Payable account is required to post a Vendor Credit.')
  const postingLines=(document.lines??[]).filter((line:Record<string,unknown>)=>['AccountBasedExpenseLineDetail','ItemBasedExpenseLineDetail','PurchaseItemLineDetail'].includes(String(line.detail_type))&&Number(line.amount??0)>0),lines:PostingLine[]=[],sourceSubtotal=postingLines.reduce((sum:number,line:Record<string,unknown>)=>sum+Number(line.amount??0),0)
  if(Math.abs(sourceSubtotal-subtotal)>0.01)throw new Error(`Vendor Credit lines (${sourceSubtotal.toFixed(4)}) do not equal subtotal (${subtotal.toFixed(4)}).`)
  for(const line of postingLines){const item=line.item as Record<string,unknown>|null,accountId=line.account_id?String(line.account_id):item?.inventory_asset_account_id?String(item.inventory_asset_account_id):accounts.expense;if(!accountId)throw new Error(`Vendor Credit line ${line.line_no} has no posting account.`);lines.push({accountId,credit:Number(line.amount),description:String(line.description??`Vendor Credit ${document.credit_no}`),costCenterId:line.cost_center_id?String(line.cost_center_id):null,exchangeRateOverride:exchangeRate})}
  if(taxAmount>0){const taxLines=await buildTaxJournalLines({companyId:cid,documentNo:String(document.credit_no),documentType:'VENDOR_CREDIT',isSales:false,components:[{name:'VAT',rate:subtotal>0?roundMoney((taxAmount/subtotal)*100):15,taxMode:'EXCLUSIVE',taxableAmount:subtotal,taxAmount,isReverseCharge:false,isWithholding:false}]});for(const line of taxLines)lines.push({accountId:line.accountId,debit:line.credit,credit:line.debit,description:line.description,exchangeRateOverride:exchangeRate})}
  lines.push({accountId:apAccount,debit:total,description:`Vendor Credit ${document.credit_no}`,exchangeRateOverride:exchangeRate})
  await postSourceDocumentToLedger({companyId:cid,sourceType:'SUPPLIER_CREDIT',sourceId:vendorCreditId,entryDate,description:`Vendor Credit ${document.credit_no}`,currency,lines})
  await postGoodsReturnToVendorFromCredit(vendorCreditId,cid)
}

export async function postSalesReceiptToLedger(receiptId:string,companyId?:string) {
  const cid=companyId??await resolveCompanyId(),client=createAdminClient(),accounts=await getAccountIds(cid)
  const result=await client.from('sales_receipts').select('*, lines:sales_receipt_lines(*)').eq('company_id',cid).eq('id',receiptId).is('deleted_at',null).single()
  if(result.error||!result.data)throw new Error('Sales Receipt not found')
  const receipt=result.data,currency=String(receipt.currency??'SAR'),entryDate=new Date(String(receipt.date)),subtotal=Number(receipt.subtotal),taxAmount=Number(receipt.tax_amount),total=Number(receipt.total)
  if(!Number.isFinite(entryDate.getTime()))throw new Error('Sales Receipt date is invalid.')
  const exchangeRate=await storeDocumentBaseAmounts('sales_receipts',receiptId,cid,currency,entryDate,subtotal,taxAmount,total,Number(receipt.exchange_rate)||null)
  const depositAccount=receipt.deposit_account_id?String(receipt.deposit_account_id):accounts.bank
  if(!depositAccount)throw new Error('A bank or Undeposited Funds account is required to post a Sales Receipt.')
  const postingLines=(receipt.lines??[]).filter((line:Record<string,unknown>)=>['SalesItemLineDetail','DiscountLineDetail'].includes(String(line.detail_type))&&Math.abs(Number(line.amount??0))>0.0001)
  const sourceSubtotal=postingLines.reduce((sum:number,line:Record<string,unknown>)=>sum+Number(line.amount),0)
  if(Math.abs(sourceSubtotal-subtotal)>0.01)throw new Error(`Sales Receipt lines (${sourceSubtotal.toFixed(4)}) do not equal subtotal (${subtotal.toFixed(4)}).`)
  const lines:PostingLine[]=[{accountId:depositAccount,debit:total,description:`Sales Receipt ${receipt.receipt_no}`,exchangeRateOverride:exchangeRate}]
  for(const line of postingLines){const accountId=line.account_id?String(line.account_id):accounts.revenue,amount=Number(line.amount);if(!accountId)throw new Error(`Sales Receipt line ${line.line_no} has no revenue account.`);lines.push({accountId,debit:amount<0?Math.abs(amount):undefined,credit:amount>0?amount:undefined,description:String(line.description??`Sales Receipt ${receipt.receipt_no}`),costCenterId:line.cost_center_id?String(line.cost_center_id):null,exchangeRateOverride:exchangeRate})}
  if(taxAmount>0){const taxLines=await buildTaxJournalLines({companyId:cid,documentNo:String(receipt.receipt_no),documentType:'SALES_RECEIPT',isSales:true,components:[{name:'VAT',rate:subtotal>0?roundMoney((taxAmount/subtotal)*100):15,taxMode:'EXCLUSIVE',taxableAmount:subtotal,taxAmount,isReverseCharge:false,isWithholding:false}]});for(const line of taxLines)lines.push({...line,exchangeRateOverride:exchangeRate})}
  try{await postSourceDocumentToLedger({companyId:cid,sourceType:'SALES_RECEIPT',sourceId:receiptId,entryDate,description:`Sales Receipt ${receipt.receipt_no}`,currency,lines})}
  catch(error){const record=error&&typeof error==='object'?error as Record<string,unknown>:{};if(String(record.code)!=='22P02'||!String(record.message??'').includes('ledger_source_type'))throw error;await postSourceDocumentToLedger({companyId:cid,sourceType:'INVOICE',sourceId:receiptId,entryDate,description:`Sales Receipt ${receipt.receipt_no}`,currency,lines})}
  await postGoodsIssueFromSalesReceipt(receiptId,cid)
}

export async function postExpenseToLedger(expenseId: string, companyId?: string, sourceCurrency?: string) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const accounts = await getAccountIds(cid)

  const { data: expense, error } = await client
    .from('expenses')
    .select('*, lines:expense_lines(*)')
    .eq('id', expenseId)
    .eq('company_id', cid)
    .single()

  if (error || !expense) throw new Error('Expense not found')
  if (!['APPROVED', 'PAID'].includes(String(expense.status))) return

  const currency = sourceCurrency || (await getCurrencyRoles(cid)).baseCurrency
  const entryDate = new Date(String(expense.date))
  const exchangeRate = Number(expense.exchange_rate)>0?Number(expense.exchange_rate):await getExchangeRateAtDate(currency, (await getCurrencyRoles(cid)).baseCurrency, entryDate, cid)

  const lines: PostingLine[] = []
  const expenseAccount = accounts.expense
  const bankAccount = accounts.bank
  const total = Number(expense.total)
  const taxAmount = Number(expense.tax_amount ?? 0)
  const subtotal = Math.max(0,total - taxAmount)

  const expenseLines = (expense.lines ?? []).filter((line: Record<string,unknown>) => Number(line.amount ?? 0) > 0)
  if (expenseLines.length) {
    for (const line of expenseLines) {
      const accountId = line.account_id ? String(line.account_id) : expenseAccount
      if (!accountId) continue
      lines.push({ accountId, debit:Number(line.amount), description:String(line.description ?? `Expense ${expense.expense_no}`), costCenterId:line.cost_center_id ? String(line.cost_center_id) : null, exchangeRateOverride:exchangeRate })
    }
  } else if (expenseAccount && subtotal > 0) {
    lines.push({ accountId:expenseAccount, debit:subtotal, description:`Expense ${expense.expense_no}`, exchangeRateOverride:exchangeRate })
  }
  if (taxAmount > 0) {
    const taxLines = await buildTaxJournalLines({ companyId:cid, documentNo:String(expense.expense_no), documentType:'EXPENSE', isSales:false, components:[{ name:'VAT', rate:subtotal > 0 ? roundMoney((taxAmount/subtotal)*100) : 15, taxMode:'EXCLUSIVE', taxableAmount:subtotal, taxAmount, isReverseCharge:false, isWithholding:false }] })
    for (const taxLine of taxLines) lines.push({ ...taxLine, exchangeRateOverride:exchangeRate })
  }
  if (bankAccount && total > 0) {
    lines.push({
      accountId: bankAccount,
      credit: total,
      description: `Expense ${expense.expense_no}`,
      exchangeRateOverride: exchangeRate,
    })
  }

  if (lines.length >= 2) {
    await postSourceDocumentToLedger({
      companyId: cid,
      sourceType: 'EXPENSE',
      sourceId: expenseId,
      entryDate,
      description: `Expense ${expense.expense_no}`,
      currency,
      lines,
    })
  }
}

export async function postPayrollToLedger(payrollId: string, companyId?: string) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const accounts = await getAccountIds(cid)

  const { data: payroll, error } = await client
    .from('payroll_entries')
    .select('*')
    .eq('id', payrollId)
    .eq('company_id', cid)
    .single()

  if (error || !payroll) throw new Error('Payroll not found')
  if (payroll.status !== 'APPROVED' && payroll.status !== 'PAID') return

  const lines: PostingLine[] = []
  const salariesAccount = accounts.salaries ?? accounts.expense
  const bankAccount = accounts.bank

  if (salariesAccount && Number(payroll.net_salary) > 0) {
    lines.push({ accountId: salariesAccount, debit: Number(payroll.net_salary), description: `Payroll ${payroll.payroll_no}` })
  }
  if (bankAccount && Number(payroll.net_salary) > 0) {
    lines.push({ accountId: bankAccount, credit: Number(payroll.net_salary), description: `Payroll ${payroll.payroll_no}` })
  }

  if (lines.length >= 2) {
    await postSourceDocumentToLedger({
      companyId: cid,
      sourceType: 'PAYROLL',
      sourceId: payrollId,
      entryDate: new Date(String(payroll.period_end)),
      description: `Payroll ${payroll.payroll_no}`,
      lines,
    })
  }
}
