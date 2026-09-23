export type QuickBooksPaymentKind = 'CUSTOMER'|'VENDOR'
export type QuickBooksCreditSourceType='VendorCredit'|'CreditMemo'|'JournalEntry'

export interface QuickBooksPaymentAllocation {
  sourceLineKey:string
  // A vendor payment line whose only LinkedTxn is a JournalEntry (no sibling Bill) settles that JE-originated AP
  // liability directly — the same JE-originating AP open item mechanism used for a normal Bill, just resolved via
  // vendor_open_items instead of `bills`. See resolveQuickBooksPaymentAllocations / vendor-open-items.ts.
  targetType:'Invoice'|'Bill'|'JournalEntry'
  targetSourceId:string
  amount:number
  cashAmount:number
  creditAmount:number
  creditSourceIds:string[]
  // Per-credit-id source entity type, keyed by the same ids in creditSourceIds — a JournalEntry-originated credit
  // (payment 2625: JE 2495 credits Bills 2624/4767) resolves through vendor_open_items rather than vendor_credits.
  // Absent/omitted entries default to the ordinary VendorCredit/CreditMemo document, preserving old callers.
  creditSourceTypes:Record<string,QuickBooksCreditSourceType>
  linkedTransactions:Array<{type:string;id:string}>
}

export interface QuickBooksPaymentRelationships {
  paymentAmount:number
  appliedAmount:number
  creditAppliedAmount:number
  unappliedAmount:number
  allocations:QuickBooksPaymentAllocation[]
  issues:string[]
}

type Row=Record<string,unknown>
const object=(value:unknown):Row=>value&&typeof value==='object'?value as Row:{}
const number=(value:unknown)=>Number.isFinite(Number(value))?Number(value):0
const round=(value:number)=>Math.round(value*10_000)/10_000
// Intuit's LinkedTxn.TxnType for a Journal Entry is "Journal Entry" (with a space) even though the entity itself is
// named "JournalEntry" everywhere else in the API — normalize both sides so this match is not sensitive to that quirk.
const normalizeTxnType=(value:string)=>value.toLowerCase().replace(/\s+/g,'')
const matchesTxnType=(item:Row,type:string)=>normalizeTxnType(String(item.TxnType??''))===normalizeTxnType(type)

/**
 * QuickBooks Payment records certified so far always carry an explicit `UnappliedAmt` (0 when nothing is left over).
 * Payments 4903/4945/4965/4967/5032 (the "5 vendor-payment exceptions") omit the field entirely — it is not merely 0,
 * it is genuinely absent from the payload. QuickBooks' own invariant for a Payment is
 * `TotalAmt = SUM(Line.Amount) + UnappliedAmt`; with the field missing, the ONLY value consistent with that
 * invariant (given the amounts QuickBooks DID report) is `TotalAmt - SUM(Line.Amount)` — not 0. This is not a guess
 * about which bill absorbs the shortfall (none does; it is genuinely unapplied/on-account cash, exactly what
 * `UnappliedAmt` already means), it is reading the one value QuickBooks' own numbers force. An explicit
 * `UnappliedAmt: 0` is left completely untouched — this inference only ever fires when the field is absent.
 */
function resolveReportedUnapplied(raw:Row,paymentAmount:number):number {
  if (Object.prototype.hasOwnProperty.call(raw,'UnappliedAmt')) return Math.max(0,round(number(raw.UnappliedAmt)))
  const rawLineSum=round((Array.isArray(raw.Line)?raw.Line:[]).reduce((sum,line)=>sum+number(object(line).Amount),0))
  return Math.max(0,round(paymentAmount-rawLineSum))
}

/**
 * A vendor payment line whose only LinkedTxn is a JournalEntry is genuinely ambiguous from the line alone: payment
 * 2625 (Bills 2624/4767 cash-settled, JE 2495 as a stand-alone line with NO sibling Bill) needs it treated as an
 * ordinary CREDIT — exactly like a VendorCredit — so the existing order-based/amount-correlation machinery pairs it
 * with Bill 2624 (first target with room), consistent with "existing payments the order-based pairing already
 * certifies keep byte-identical allocations." Payment 2671 (no Bill anywhere in the payment at all — one of the "29
 * JE-linked vendor payments") needs the OPPOSITE: promoted into its own direct settlement target, because there is
 * nothing for it to credit. Rather than guess which case a given payment is from shape alone, try the CREDIT
 * interpretation first (uniform with the already-certified VendorCredit behavior) and only fall back to the TARGET
 * interpretation — and only for VENDOR payments — when the credit interpretation cannot reconcile.
 */
export function extractQuickBooksPaymentRelationships(raw:Row,kind:QuickBooksPaymentKind):QuickBooksPaymentRelationships {
  const asCredit=attemptExtraction(raw,kind,false)
  if(asCredit.issues.length===0||kind!=='VENDOR')return asCredit
  const asTarget=attemptExtraction(raw,kind,true)
  return asTarget.issues.length===0?asTarget:asCredit
}

function attemptExtraction(raw:Row,kind:QuickBooksPaymentKind,promoteJournalTargets:boolean):QuickBooksPaymentRelationships {
  const primaryTargetType=kind==='CUSTOMER'?'Invoice':'Bill'
  // A vendor payment's credit sources include both an ordinary VendorCredit and a JournalEntry-originated credit
  // (see createJournalVendorOpenItems: a JE AP-line that is a Debit represents the same kind of reduction).
  const creditTypeCandidates:Array<{type:string;sourceType:QuickBooksCreditSourceType}> = kind==='CUSTOMER'
    ? [{type:'CreditMemo',sourceType:'CreditMemo'}]
    : [{type:'VendorCredit',sourceType:'VendorCredit'},{type:'JournalEntry',sourceType:'JournalEntry'}]
  const paymentAmount=round(number(raw.TotalAmt??raw.Amount)),reportedUnapplied=resolveReportedUnapplied(raw,paymentAmount)
  const allocations:QuickBooksPaymentAllocation[]=[],issues:string[]=[]
  const standaloneCredits:Array<{sourceId:string;remaining:number;lineIndex:number;sourceType:QuickBooksCreditSourceType}>=[]
  for(const [index,lineValue] of (Array.isArray(raw.Line)?raw.Line:[]).entries()){
    const line=object(lineValue),linked=(Array.isArray(line.LinkedTxn)?line.LinkedTxn:[]).map(item=>object(item))
    const primaryTargets=linked.filter(item=>matchesTxnType(item,primaryTargetType))
    // A vendor payment line whose only link is a JournalEntry (no Bill) settles that JE-originated AP liability
    // directly — the 29 JE-linked vendor payments this closes. Only engaged when the caller has already established
    // (by retrying with the credit interpretation first) that treating it as a credit cannot reconcile the payment.
    const journalTargets=promoteJournalTargets&&kind==='VENDOR'&&primaryTargets.length===0?linked.filter(item=>matchesTxnType(item,'JournalEntry')):[]
    const targets=primaryTargets.length?primaryTargets:journalTargets
    const targetType:QuickBooksPaymentAllocation['targetType']=primaryTargets.length?primaryTargetType:'JournalEntry'
    const credits=linked.filter(item=>creditTypeCandidates.some(candidate=>matchesTxnType(item,candidate.type))&&!targets.includes(item))
    const creditSourceType=(item:Row):QuickBooksCreditSourceType=>creditTypeCandidates.find(candidate=>matchesTxnType(item,candidate.type))?.sourceType??'VendorCredit'
    if(targets.length===0){for(const credit of credits){const id=String(credit.TxnId??'');if(id)standaloneCredits.push({sourceId:id,remaining:round(number(line.Amount)),lineIndex:index,sourceType:creditSourceType(credit)})}continue}
    if(targets.length!==1){issues.push(`Payment line ${index+1} links ${targets.length} ${targetType} records; the allocation amount is ambiguous.`);continue}
    const targetSourceId=String(targets[0].TxnId??'')
    const amount=round(number(line.Amount))
    if(!targetSourceId||amount<=0){issues.push(`Payment line ${index+1} has no target ID or positive allocation amount.`);continue}
    const creditIds=credits.map(item=>String(item.TxnId??'')).filter(Boolean)
    allocations.push({sourceLineKey:`line:${index}:${targetType}:${targetSourceId}`,targetType,targetSourceId,amount,cashAmount:amount,creditAmount:0,creditSourceIds:creditIds,creditSourceTypes:Object.fromEntries(credits.filter(item=>String(item.TxnId??'')).map(item=>[String(item.TxnId),creditSourceType(item)])),linkedTransactions:linked.map(item=>({type:String(item.TxnType??''),id:String(item.TxnId??'')})).filter(item=>item.id)})
  }
  const totalApplied=round(allocations.reduce((sum,item)=>sum+item.amount,0)),cashApplied=Math.max(0,round(paymentAmount-reportedUnapplied))
  const lineIssueCount=issues.length,creditToApply=Math.max(0,round(totalApplied-cashApplied)),baseAllocations=allocations.map(item=>({...item,creditSourceIds:[...item.creditSourceIds],creditSourceTypes:{...item.creditSourceTypes}})),baseCredits=standaloneCredits.map(item=>({...item}))
  let creditRemaining=creditToApply
  for(const allocation of allocations){
    if(!allocation.creditSourceIds.length&&creditRemaining>0){let needed=Math.min(allocation.amount,creditRemaining);for(const credit of standaloneCredits){if(needed<=0)break;const used=Math.min(needed,credit.remaining);if(used<=0)continue;allocation.creditSourceIds.push(credit.sourceId);allocation.creditSourceTypes[credit.sourceId]=credit.sourceType;credit.remaining=round(credit.remaining-used);needed=round(needed-used)}}
    if(!allocation.creditSourceIds.length)continue
    allocation.creditAmount=Math.min(allocation.amount,creditRemaining);allocation.cashAmount=round(allocation.amount-allocation.creditAmount);creditRemaining=round(creditRemaining-allocation.creditAmount)
  }
  issues.push(...creditApplicationIssues(allocations,creditRemaining,cashApplied))
  // Fail-closed fallback: only reached when the order-based pairing above could not produce a certifiable result.
  if(lineIssueCount===0&&issues.length>0&&baseCredits.length>0){
    const correlated=correlateStandaloneCredits(baseAllocations,baseCredits,creditToApply)
    if(correlated&&creditApplicationIssues(correlated,0,cashApplied).length===0){allocations.length=0;allocations.push(...correlated);issues.length=0}
  }
  const allocatedCash=round(allocations.reduce((sum,item)=>sum+item.cashAmount,0))
  return {paymentAmount,appliedAmount:allocatedCash,creditAppliedAmount:round(allocations.reduce((sum,item)=>sum+item.creditAmount,0)),unappliedAmount:reportedUnapplied,allocations,issues}
}

function creditApplicationIssues(allocations:QuickBooksPaymentAllocation[],creditRemaining:number,cashApplied:number):string[] {
  const issues:string[]=[]
  for(const allocation of allocations)if(allocation.creditAmount>0&&allocation.creditSourceIds.length!==1)issues.push(`${allocation.sourceLineKey} must identify exactly one credit for ${allocation.creditAmount.toFixed(4)} of applied credit.`)
  if(creditRemaining>0)issues.push(`${creditRemaining.toFixed(4)} of applied credits cannot be tied to an explicit QuickBooks credit relationship.`)
  const allocatedCash=round(allocations.reduce((sum,item)=>sum+item.cashAmount,0))
  if(Math.abs(allocatedCash-cashApplied)>0.0001)issues.push(`QuickBooks cash application total ${cashApplied.toFixed(4)} does not equal linked-line cash ${allocatedCash.toFixed(4)}.`)
  return issues
}

const MAX_CORRELATION_ITEMS=16,MAX_CORRELATION_STEPS=200_000

/**
 * QuickBooks lists credit memos that a payment consumed as stand-alone lines without saying which invoice each one
 * settled. When the amounts prove it, pair them exactly: every credit is assigned to an invoice line so that each
 * credited line is settled by credits summing to exactly its amount. Returns null unless that pairing is unique.
 */
function correlateStandaloneCredits(base:QuickBooksPaymentAllocation[],credits:Array<{sourceId:string;remaining:number;lineIndex:number;sourceType:QuickBooksCreditSourceType}>,creditToApply:number):QuickBooksPaymentAllocation[]|null {
  if(creditToApply<=0||base.length===0||base.length>MAX_CORRELATION_ITEMS||credits.length>MAX_CORRELATION_ITEMS)return null
  if(base.some(item=>item.creditSourceIds.length>0)||credits.some(item=>item.remaining<=0))return null
  if(Math.abs(round(credits.reduce((sum,item)=>sum+item.remaining,0))-creditToApply)>0.0001)return null
  const assigned:number[][]=base.map(()=>[]),sums=base.map(()=>0)
  const solutions:number[][][]=[]
  let steps=0,exhausted=false
  const search=(creditIndex:number)=>{
    if(exhausted||solutions.length>1)return
    if(++steps>MAX_CORRELATION_STEPS){exhausted=true;return}
    if(creditIndex===credits.length){if(base.every((item,index)=>sums[index]===0||Math.abs(sums[index]-item.amount)<=0.0001))solutions.push(assigned.map(list=>[...list]));return}
    for(let target=0;target<base.length;target++){
      const next=round(sums[target]+credits[creditIndex].remaining)
      if(next-base[target].amount>0.0001)continue
      assigned[target].push(creditIndex);sums[target]=next
      search(creditIndex+1)
      assigned[target].pop();sums[target]=round(sums[target]-credits[creditIndex].remaining)
    }
  }
  search(0)
  if(exhausted||solutions.length!==1)return null
  const result:QuickBooksPaymentAllocation[]=[]
  for(const [index,allocation] of base.entries()){
    const creditIndexes=solutions[0][index]
    if(creditIndexes.length===0){result.push(allocation);continue}
    if(creditIndexes.length===1){const credit=credits[creditIndexes[0]];result.push({...allocation,creditSourceIds:[credit.sourceId],creditSourceTypes:{[credit.sourceId]:credit.sourceType},creditAmount:allocation.amount,cashAmount:0});continue}
    for(const creditIndex of creditIndexes){const credit=credits[creditIndex];result.push({...allocation,sourceLineKey:`${allocation.sourceLineKey}:credit:${credit.lineIndex}:${credit.sourceId}`,amount:credit.remaining,cashAmount:0,creditAmount:credit.remaining,creditSourceIds:[credit.sourceId],creditSourceTypes:{[credit.sourceId]:credit.sourceType}})}
  }
  return result
}
