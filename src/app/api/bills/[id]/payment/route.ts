import { postPaymentToLedger } from '@/lib/accounting/document-posting'
import { getCompanyPrimaryCurrency } from '@/lib/currency/company'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'
import { logAudit } from '@/lib/audit/log'
import { requireRole } from '@/lib/authz'
import { resolvePaymentMethod } from '@/lib/product-parity/payment-methods'
import { createAdminClient } from '@/lib/supabase/admin'
import { replacePaymentAllocations } from '@/lib/accounting/payment-allocations'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const companyId = await resolveCompanyId()
    const { id } = await params
    const body = await request.json()

    const bill = await prisma.bill.findUnique({ where: { id, companyId } })
    if (!bill) return Response.json({ error: 'Bill not found' }, { status: 404 })
    if (bill.balance <= 0) return Response.json({ error: 'Bill is already fully paid' }, { status: 400 })

    const requestedAmount = Number(body.amount)
    if (Number.isNaN(requestedAmount) || requestedAmount <= 0) {
      return Response.json({ error: 'A positive payment amount is required' }, { status: 400 })
    }

    const appliedAmount = Math.min(requestedAmount, bill.balance)
    const paymentNo = await getNextSequence('PAYMENT', 'PAY-')
    const currency = bill.currency || await getCompanyPrimaryCurrency()
    const method = await resolvePaymentMethod(companyId, body.paymentMethodId, body.method || 'BANK_TRANSFER')

    const payment = await prisma.payment.create({
      data: {
        paymentNo,
        billId: id,
        date: new Date(body.date || new Date()),
        currency,
        amount: requestedAmount,
        method: method.code,
        reference: body.reference,
        notes: body.notes,
        bankAccountId: body.bankAccountId || null,
      },
    })
    const { error: methodError } = await createAdminClient().from('payments').update({ payment_method_id: method.id }).eq('company_id', companyId).eq('id', payment.id)
    if (methodError) throw methodError
    await replacePaymentAllocations(companyId,payment.id,[{billId:id,amount:appliedAmount,cashAmount:appliedAmount,creditAmount:0,currency,sourceSystem:'HISAB',sourceLineKey:`bill:${id}`}])
    await postPaymentToLedger(payment.id, companyId)
    await logAudit({
      companyId,
      userId: user.id,
      action: 'PAYMENT',
      entityType: 'bill',
      entityId: id,
      details: { paymentId: payment.id, amount:requestedAmount, appliedAmount, paymentNo },
    })
    const updated = await prisma.bill.findUnique({ where: { id, companyId } })
    return Response.json(updated)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
