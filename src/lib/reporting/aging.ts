import 'server-only'
import { prisma } from '@/lib/prisma'
import { ageBucket } from './aging-utils'
import { resolveCompanyId } from '@/lib/tenant'
import { listAllOpenVendorItems } from '@/lib/accounting/vendor-open-items'

export async function buildAgedReceivablesReport(asOf: Date) {
  const companyId=await resolveCompanyId()
  const [invoices,overpayments,credits] = await Promise.all([prisma.invoice.findMany({
    where: {
      balance: { gt: 0 },
      status: { in: ['SENT', 'PAID', 'PARTIAL'] },
      date: { lte: asOf },
      companyId,
      invoiceType: { not: 'CREDIT_NOTE' },
    },
    include: { customer: { select: { id: true, name: true } } },
    orderBy: { dueDate: 'asc' },
  }),prisma.payment.findMany({where:{companyId,unappliedAmount:{gt:0},date:{lte:asOf}},include:{customer:{select:{id:true,name:true}}},orderBy:{date:'asc'}}),prisma.invoice.findMany({where:{companyId,invoiceType:'CREDIT_NOTE',balance:{gt:0},date:{lte:asOf}},include:{customer:{select:{id:true,name:true}}},orderBy:{date:'asc'}})])

  const buckets: Record<string, { total: number; count: number }> = {
    current: { total: 0, count: 0 },
    '1-30': { total: 0, count: 0 },
    '31-60': { total: 0, count: 0 },
    '61-90': { total: 0, count: 0 },
    '90+': { total: 0, count: 0 },
  }

  const details: Array<Record<string,unknown>&{balance:number}> = invoices.map((inv: {
    id: string; invoiceNo: string; date: Date; dueDate: Date; total: number; balance: number
    customer: { id: string; name: string } | null
  }) => {
    const daysPastDue = Math.floor((asOf.getTime() - new Date(inv.dueDate).getTime()) / (1000 * 60 * 60 * 24))
    const bucket = ageBucket(daysPastDue)
    buckets[bucket].total += inv.balance
    buckets[bucket].count += 1
    return {
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      customer: inv.customer,
      customerName: inv.customer?.name ?? '',
      date: inv.date,
      dueDate: inv.dueDate,
      total: inv.total,
      balance: inv.balance,
      amount: inv.balance,
      daysPastDue,
      bucket,
    }
  })
  for(const payment of (overpayments as Array<{id:string;paymentNo:string;date:Date;unappliedAmount:number;customer:{id:string;name:string}|null}>).filter(item=>item.customer)){const balance=-Number(payment.unappliedAmount);buckets.current.total+=balance;buckets.current.count+=1;details.push({id:payment.id,invoiceNo:payment.paymentNo,customer:payment.customer,customerName:payment.customer?.name??'',date:payment.date,dueDate:payment.date,total:0,balance,amount:balance,daysPastDue:0,bucket:'current',sourceType:'OVERPAYMENT'})}
  for(const credit of credits as Array<{id:string;invoiceNo:string;date:Date;balance:number;customer:{id:string;name:string}|null}>){const balance=-Number(credit.balance);buckets.current.total+=balance;buckets.current.count+=1;details.push({id:credit.id,invoiceNo:credit.invoiceNo,customer:credit.customer,customerName:credit.customer?.name??'',date:credit.date,dueDate:credit.date,total:0,balance,amount:balance,daysPastDue:0,bucket:'current',sourceType:'CREDIT_NOTE'})}

  const grandTotal = details.reduce((s: number, d: { balance: number }) => s + d.balance, 0)

  return {
    asOf: asOf.toISOString(),
    type: 'AGED_AR',
    buckets,
    grandTotal,
    details,
  }
}

export async function buildAgedPayablesReport(asOf: Date) {
  const companyId=await resolveCompanyId()
  const [bills,overpayments,credits,openItems] = await Promise.all([prisma.bill.findMany({
    where: {
      balance: { gt: 0 },
      status: { in: ['RECEIVED', 'PAID', 'PARTIAL'] },
      date: { lte: asOf },
      companyId,
    },
    include: { vendor: { select: { id: true, name: true } } },
    orderBy: { dueDate: 'asc' },
  }),prisma.payment.findMany({where:{companyId,unappliedAmount:{gt:0},date:{lte:asOf}},include:{vendor:{select:{id:true,name:true}}},orderBy:{date:'asc'}}),prisma.vendorCredit.findMany({where:{companyId,balance:{gt:0},date:{lte:asOf}},include:{vendor:{select:{id:true,name:true}}},orderBy:{date:'asc'}}),listAllOpenVendorItems(companyId,asOf)])

  const buckets: Record<string, { total: number; count: number }> = {
    current: { total: 0, count: 0 },
    '1-30': { total: 0, count: 0 },
    '31-60': { total: 0, count: 0 },
    '61-90': { total: 0, count: 0 },
    '90+': { total: 0, count: 0 },
  }

  const details: Array<Record<string,unknown>&{balance:number}> = bills.map((bill: {
    id: string; billNo: string; date: Date; dueDate: Date; total: number; balance: number
    vendor: { id: string; name: string } | null
  }) => {
    const daysPastDue = Math.floor((asOf.getTime() - new Date(bill.dueDate).getTime()) / (1000 * 60 * 60 * 24))
    const bucket = ageBucket(daysPastDue)
    buckets[bucket].total += bill.balance
    buckets[bucket].count += 1
    return {
      id: bill.id,
      billNo: bill.billNo,
      vendor: bill.vendor,
      vendorName: bill.vendor?.name ?? '',
      date: bill.date,
      dueDate: bill.dueDate,
      total: bill.total,
      balance: bill.balance,
      amount: bill.balance,
      daysPastDue,
      bucket,
    }
  })
  for(const payment of (overpayments as Array<{id:string;paymentNo:string;date:Date;unappliedAmount:number;vendor:{id:string;name:string}|null}>).filter(item=>item.vendor)){const balance=-Number(payment.unappliedAmount);buckets.current.total+=balance;buckets.current.count+=1;details.push({id:payment.id,billNo:payment.paymentNo,vendor:payment.vendor,vendorName:payment.vendor?.name??'',date:payment.date,dueDate:payment.date,total:0,balance,amount:balance,daysPastDue:0,bucket:'current',sourceType:'OVERPAYMENT'})}
  for(const credit of credits as Array<{id:string;creditNo:string;date:Date;balance:number;vendor:{id:string;name:string}|null}>){const balance=-Number(credit.balance);buckets.current.total+=balance;buckets.current.count+=1;details.push({id:credit.id,billNo:credit.creditNo,vendor:credit.vendor,vendorName:credit.vendor?.name??'',date:credit.date,dueDate:credit.date,total:0,balance,amount:balance,daysPastDue:0,bucket:'current',sourceType:'VENDOR_CREDIT'})}
  // JE/expense-originating AP open items (items 2/3): a PAYABLE item ages like an unpaid bill (no separate due date,
  // so age from its own date); a CREDIT item behaves like a vendor credit and always buckets to 'current'.
  for(const item of openItems){
    const documentId=item.sourceReference.split(':')[0],label=`QuickBooks ${item.sourceType==='JOURNAL_ENTRY'?'Journal Entry':'Expense'} ${documentId}`
    if(item.direction==='PAYABLE'){
      const daysPastDue=Math.floor((asOf.getTime()-item.date.getTime())/(1000*60*60*24)),bucket=ageBucket(daysPastDue)
      buckets[bucket].total+=item.balance;buckets[bucket].count+=1
      details.push({id:item.id,billNo:label,vendor:{id:item.vendorId,name:item.vendorName},vendorName:item.vendorName,date:item.date,dueDate:item.date,total:item.total,balance:item.balance,amount:item.balance,daysPastDue,bucket,sourceType:'JE_OPEN_ITEM'})
    } else {
      const balance=-item.balance
      buckets.current.total+=balance;buckets.current.count+=1
      details.push({id:item.id,billNo:label,vendor:{id:item.vendorId,name:item.vendorName},vendorName:item.vendorName,date:item.date,dueDate:item.date,total:0,balance,amount:balance,daysPastDue:0,bucket:'current',sourceType:'JE_OPEN_ITEM_CREDIT'})
    }
  }

  const grandTotal = details.reduce((s: number, d: { balance: number }) => s + d.balance, 0)

  return {
    asOf: asOf.toISOString(),
    type: 'AGED_AP',
    buckets,
    grandTotal,
    grandTotalPayable: grandTotal,
    details,
  }
}
