import { requireAuth } from '@/lib/auth'
import { postBillToLedger } from '@/lib/accounting/document-posting'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'
import { logAudit } from '@/lib/audit/log'
import { requireRole } from '@/lib/authz'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const bill = await prisma.bill.findUnique({
      where: { id, companyId },
      include: { vendor: true, lines: { include: { account: true } }, payments: true },
    })
    if (!bill) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(bill)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const companyId = await resolveCompanyId()
    const { id } = await params
    const body = await request.json()
    const existing = await prisma.bill.findUnique({ where: { id, companyId } })
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    let subtotal = 0
    let taxAmount = 0
    const processedLines = (body.lines || []).map((l: {
      description: string; quantity: number; unitPrice: number; taxRate: number
      accountId?: string; costCenterId?: string
    }) => {
      const lineAmount = l.quantity * l.unitPrice
      const lineTax = lineAmount * (l.taxRate / 100)
      subtotal += lineAmount
      taxAmount += lineTax
      return { ...l, amount: lineAmount }
    })

    const total = subtotal + taxAmount
    const balance = total - existing.amountPaid
    const resolvedCurrency = body.currency !== undefined
      ? await resolveTransactionCurrency(body.currency)
      : existing.currency

    await prisma.billLine.deleteMany({ where: { billId: id } })

    const nextStatus = body.status || existing.status
    const bill = await prisma.bill.update({
      where: { id, companyId },
      data: {
        vendorId: body.vendorId,
        date: new Date(body.date),
        dueDate: new Date(body.dueDate),
        currency: resolvedCurrency,
        subtotal,
        taxAmount,
        total,
        balance,
        notes: body.notes,
        reference: body.reference,
        status: nextStatus,
        approvalStatus: body.approvalStatus ?? existing.approvalStatus,
        purchaseOrderId: body.purchaseOrderId !== undefined ? (body.purchaseOrderId || null) : existing.purchaseOrderId,
        isRecurring: body.isRecurring ?? existing.isRecurring,
        recurringDay: body.recurringDay !== undefined ? body.recurringDay : existing.recurringDay,
        lines: {
          create: processedLines.map((l: {
            description: string; quantity: number; unitPrice: number
            taxRate: number; amount: number; accountId?: string; costCenterId?: string
          }) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            amount: l.amount,
            accountId: l.accountId || null,
            costCenterId: l.costCenterId || null,
          })),
        },
      },
      include: { vendor: { select: { name: true } }, lines: true },
    })

    if (nextStatus === 'RECEIVED' && existing.status !== 'RECEIVED') {
      await postBillToLedger(id, companyId)
    }

    await logAudit({ companyId, userId: user.id, action: 'BILL_UPDATED', entityType: 'bill', entityId: id, details: { billNo: bill.billNo } })

    return Response.json(bill)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const companyId = await resolveCompanyId()
    const { id } = await params
    await prisma.bill.delete({ where: { id, companyId } })
    await logAudit({ companyId, userId: user.id, action: 'BILL_DELETED', entityType: 'bill', entityId: id })
    return Response.json({ success: true })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
