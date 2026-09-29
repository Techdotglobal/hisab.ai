import { requireAuth } from '@/lib/auth'
import { postPaymentToLedger } from '@/lib/accounting/document-posting'
import { getCompanyPrimaryCurrency } from '@/lib/currency/company'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'
import { resolvePaymentMethod } from '@/lib/product-parity/payment-methods'
import { createAdminClient } from '@/lib/supabase/admin'
import { replacePaymentAllocations } from '@/lib/accounting/payment-allocations'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const body = await request.json()

    const invoice = await prisma.invoice.findUnique({ where: { id, companyId } })
    if (!invoice) return Response.json({ error: 'Invoice not found' }, { status: 404 })
    if (invoice.balance <= 0) return Response.json({ error: 'Invoice is already fully paid' }, { status: 400 })

    const requestedAmount = Number(body.amount)
    if (Number.isNaN(requestedAmount) || requestedAmount <= 0) {
      return Response.json({ error: 'A positive payment amount is required' }, { status: 400 })
    }

    const appliedAmount = Math.min(requestedAmount, invoice.balance)
    const paymentNo = await getNextSequence('PAYMENT', 'PAY-')
    const currency = invoice.currency || await getCompanyPrimaryCurrency()
    const method = await resolvePaymentMethod(companyId, body.paymentMethodId, body.method || 'BANK_TRANSFER')

    const payment = await prisma.payment.create({
      data: {
        paymentNo,
        invoiceId: id,
        date: new Date(body.date || new Date()),
        currency,
        amount: requestedAmount,
        method: method.code,
        reference: body.reference,
        notes: body.notes,
      },
    })
    const { error: methodError } = await createAdminClient().from('payments').update({ payment_method_id: method.id }).eq('company_id', companyId).eq('id', payment.id)
    if (methodError) throw methodError
    await replacePaymentAllocations(companyId,payment.id,[{invoiceId:id,amount:appliedAmount,cashAmount:appliedAmount,creditAmount:0,currency,sourceSystem:'HISAB',sourceLineKey:`invoice:${id}`}])
    await postPaymentToLedger(payment.id, companyId)
    const updated = await prisma.invoice.findUnique({ where: { id, companyId } })
    return Response.json(updated)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
