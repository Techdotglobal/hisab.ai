import 'server-only'
import { postSourceDocumentToLedger, postJournalEntry } from '@/lib/accounting/posting-service'
import { createAdminClient } from '@/lib/supabase/admin'

export async function createBankTransfer(input:{ companyId:string; userId?:string|null; transferNo:string; fromAccountId:string; toAccountId:string; date:Date; amount:number; reference?:string|null }) {
  if(input.fromAccountId===input.toAccountId) throw new Error('Source and destination accounts must differ')
  if(!Number.isFinite(input.amount)||input.amount<=0) throw new Error('amount must be positive')
  const db=createAdminClient()
  const accounts=await db.from('bank_accounts').select('id,current_balance,name,account_id,currency').eq('company_id',input.companyId).in('id',[input.fromAccountId,input.toAccountId]).is('deleted_at',null)
  if(accounts.error) throw accounts.error
  const from=accounts.data?.find(account=>account.id===input.fromAccountId); const to=accounts.data?.find(account=>account.id===input.toAccountId)
  if(!from||!to) throw new Error('Bank account not found')
  if(Number(from.current_balance)<input.amount) throw new Error('Insufficient balance in source account')
  const existing=await db.from('bank_transfers').select('id').eq('company_id',input.companyId).eq('transfer_no',input.transferNo).maybeSingle()
  if(existing.error) throw existing.error
  let transferId=existing.data?.id?String(existing.data.id):''
  if(!transferId) {
    const created=await db.from('bank_transfers').insert({company_id:input.companyId,transfer_no:input.transferNo,from_account_id:input.fromAccountId,to_account_id:input.toAccountId,date:input.date.toISOString(),amount:input.amount,reference:input.reference??null}).select('id').single()
    if(created.error) throw created.error
    transferId=String(created.data.id)
    const fromUpdate=await db.from('bank_accounts').update({current_balance:Number(from.current_balance)-input.amount,updated_at:new Date().toISOString()}).eq('company_id',input.companyId).eq('id',input.fromAccountId)
    if(fromUpdate.error) throw fromUpdate.error
    const toUpdate=await db.from('bank_accounts').update({current_balance:Number(to.current_balance)+input.amount,updated_at:new Date().toISOString()}).eq('company_id',input.companyId).eq('id',input.toAccountId)
    if(toUpdate.error) throw toUpdate.error
    const bankRows=await db.from('bank_transactions').insert([{company_id:input.companyId,bank_account_id:input.fromAccountId,transaction_date:input.date.toISOString(),description:`Transfer to ${to.name} (${input.transferNo})`,reference:input.reference??input.transferNo,amount:input.amount,type:'DEBIT',status:'MATCHED',source_type:'BANK_TRANSFER',source_id:transferId},{company_id:input.companyId,bank_account_id:input.toAccountId,transaction_date:input.date.toISOString(),description:`Transfer from ${from.name} (${input.transferNo})`,reference:input.reference??input.transferNo,amount:input.amount,type:'CREDIT',status:'MATCHED',source_type:'BANK_TRANSFER',source_id:transferId}])
    if(bankRows.error) throw bankRows.error
  }
  if(from.account_id&&to.account_id) await postSourceDocumentToLedger({companyId:input.companyId,sourceType:'BANK_TRANSFER',sourceId:transferId,entryDate:input.date,description:`Bank transfer ${input.transferNo}`,currency:String(from.currency??'SAR'),lines:[{accountId:String(to.account_id),debit:input.amount,description:`Transfer from ${from.name}`},{accountId:String(from.account_id),credit:input.amount,description:`Transfer to ${to.name}`}],userId:input.userId,reason:'Bank transfer'})
  return {id:transferId,transferNo:input.transferNo}
}

/**
 * Posts a QuickBooks Transfer whose counterparty is not itself a tracked `bank_accounts` row (e.g. a Bank -> Other
 * Current Asset employee-advance move, or a Bank -> Long-Term Liability move). `bank_transfers`/`createBankTransfer`
 * structurally require both legs to be `bank_accounts` (NOT NULL FKs, current_balance tracking, a bank_transactions
 * feed) — forcing a non-bank counterparty into that table merely to satisfy the schema would misrepresent it as a bank
 * account. This instead posts a plain, balanced Dr destination / Cr source journal entry (no P&L effect), reusing the
 * journal_entries/journal_lines idempotency pattern already used for QuickBooks opening balances
 * (`postIdempotentOpeningBalance`): a stable legacy_id makes re-materializing the same transfer a no-op, and a changed
 * source amount after posting fails loudly instead of silently double-posting or drifting.
 */
export async function postIdempotentTransferJournal(input:{
  companyId:string; userId?:string|null; date:Date; legacyId:string; entryNo:string; description:string
  fromAccountId:string; toAccountId:string; amount:number
}): Promise<string> {
  if(input.fromAccountId===input.toAccountId) throw new Error('Source and destination accounts must differ')
  if(!Number.isFinite(input.amount)||input.amount<=0) throw new Error('amount must be positive')
  const db=createAdminClient()
  const lines=[{account_id:input.toAccountId,debit:input.amount,credit:0},{account_id:input.fromAccountId,debit:0,credit:input.amount}]
  const signature=(values:{account_id:string;debit:number;credit:number}[])=>values.map(l=>`${l.account_id}:${Number(l.debit).toFixed(4)}:${Number(l.credit).toFixed(4)}`).sort().join('|')

  const existing=await db.from('journal_entries').select('id,status').eq('company_id',input.companyId).eq('legacy_id',input.legacyId).is('deleted_at',null).maybeSingle()
  if(existing.error) throw existing.error

  if(existing.data?.status==='POSTED'){
    const current=await db.from('journal_lines').select('account_id,debit,credit').eq('company_id',input.companyId).eq('journal_id',existing.data.id)
    if(current.error) throw current.error
    const actual=(current.data??[]).map(l=>({account_id:String(l.account_id),debit:Number(l.debit),credit:Number(l.credit)}))
    if(signature(actual)!==signature(lines)) throw new Error(`QuickBooks transfer ${input.legacyId} changed after it was posted; resolve the synchronization conflict.`)
    return String(existing.data.id)
  }

  let journalId:string
  if(existing.data){
    journalId=String(existing.data.id)
    const updated=await db.from('journal_entries').update({date:input.date.toISOString(),description:input.description,total_debit:input.amount,total_credit:input.amount}).eq('company_id',input.companyId).eq('id',journalId)
    if(updated.error) throw updated.error
    const removed=await db.from('journal_lines').delete().eq('company_id',input.companyId).eq('journal_id',journalId)
    if(removed.error) throw removed.error
  } else {
    const created=await db.from('journal_entries').insert({company_id:input.companyId,legacy_id:input.legacyId,entry_no:input.entryNo,date:input.date.toISOString(),description:input.description,status:'DRAFT',total_debit:input.amount,total_credit:input.amount,created_by_id:input.userId??null}).select('id').single()
    if(created.error) throw created.error
    journalId=String(created.data.id)
  }
  const inserted=await db.from('journal_lines').insert(lines.map(l=>({company_id:input.companyId,journal_id:journalId,account_id:l.account_id,debit:l.debit,credit:l.credit})))
  if(inserted.error) throw inserted.error
  await postJournalEntry(journalId,{companyId:input.companyId,userId:input.userId,reason:'QuickBooks bank transfer'})
  return journalId
}
