export type QuickBooksPaymentKind = 'CUSTOMER'|'VENDOR'

export interface QuickBooksPaymentAllocation {
  sourceLineKey:string
  targetType:'Invoice'|'Bill'
  targetSourceId:string
  amount:number
  cashAmount:number
  creditAmount:number
  creditSourceIds:string[]
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

export function extractQuickBooksPaymentRelationships(raw:Row,kind:QuickBooksPaymentKind):QuickBooksPaymentRelationships {
  const targetType=kind==='CUSTOMER'?'Invoice':'Bill',creditType=kind==='CUSTOMER'?'CreditMemo':'VendorCredit'
  const paymentAmount=round(number(raw.TotalAmt??raw.Amount)),reportedUnapplied=Math.max(0,round(number(raw.UnappliedAmt)))
  const allocations:QuickBooksPaymentAllocation[]=[],issues:string[]=[],standaloneCredits:Array<{sourceId:string;remaining:number;lineIndex:number}>=[]
  for(const [index,lineValue] of (Array.isArray(raw.Line)?raw.Line:[]).entries()){
    const line=object(lineValue),linked=(Array.isArray(line.LinkedTxn)?line.LinkedTxn:[]).map(item=>object(item))
    const targets=linked.filter(item=>String(item.TxnType??'').toLowerCase()===targetType.toLowerCase())
    const credits=linked.filter(item=>String(item.TxnType??'').toLowerCase()===creditType.toLowerCase())
    if(targets.length===0){for(const credit of credits){const id=String(credit.TxnId??'');if(id)standaloneCredits.push({sourceId:id,remaining:round(number(line.Amount)),lineIndex:index})}continue}
    if(targets.length!==1){issues.push(`Payment line ${index+1} links ${targets.length} ${targetType} records; the allocation amount is ambiguous.`);continue}
    const targetSourceId=String(targets[0].TxnId??'')
    const amount=round(number(line.Amount))
    if(!targetSourceId||amount<=0){issues.push(`Payment line ${index+1} has no target ID or positive allocation amount.`);continue}
    allocations.push({sourceLineKey:`line:${index}:${targetType}:${targetSourceId}`,targetType,targetSourceId,amount,cashAmount:amount,creditAmount:0,creditSourceIds:credits.map(item=>String(item.TxnId??'')).filter(Boolean),linkedTransactions:linked.map(item=>({type:String(item.TxnType??''),id:String(item.TxnId??'')})).filter(item=>item.id)})
  }
  const totalApplied=round(allocations.reduce((sum,item)=>sum+item.amount,0)),cashApplied=Math.max(0,round(paymentAmount-reportedUnapplied))
  const lineIssueCount=issues.length,creditToApply=Math.max(0,round(totalApplied-cashApplied)),baseAllocations=allocations.map(item=>({...item,creditSourceIds:[...item.creditSourceIds]})),baseCredits=standaloneCredits.map(item=>({...item}))
  let creditRemaining=creditToApply
  for(const allocation of allocations){
    if(!allocation.creditSourceIds.length&&creditRemaining>0){let needed=Math.min(allocation.amount,creditRemaining);for(const credit of standaloneCredits){if(needed<=0)break;const used=Math.min(needed,credit.remaining);if(used<=0)continue;allocation.creditSourceIds.push(credit.sourceId);credit.remaining=round(credit.remaining-used);needed=round(needed-used)}}
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
function correlateStandaloneCredits(base:QuickBooksPaymentAllocation[],credits:Array<{sourceId:string;remaining:number;lineIndex:number}>,creditToApply:number):QuickBooksPaymentAllocation[]|null {
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
    if(creditIndexes.length===1){result.push({...allocation,creditSourceIds:[credits[creditIndexes[0]].sourceId],creditAmount:allocation.amount,cashAmount:0});continue}
    for(const creditIndex of creditIndexes){const credit=credits[creditIndex];result.push({...allocation,sourceLineKey:`${allocation.sourceLineKey}:credit:${credit.lineIndex}:${credit.sourceId}`,amount:credit.remaining,cashAmount:0,creditAmount:credit.remaining,creditSourceIds:[credit.sourceId]})}
  }
  return result
}
