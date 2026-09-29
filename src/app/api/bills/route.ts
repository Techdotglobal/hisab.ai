import { requireAuth } from '@/lib/auth'
import { postBillToLedger } from '@/lib/accounting/document-posting'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { maybeStartWorkflow } from '@/lib/workflow/integration'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'
import { logAudit } from '@/lib/audit/log'
import { requireRole } from '@/lib/authz'

export async function GET(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? ''
    const status = searchParams.get('status') ?? ''
    const approvalStatus = searchParams.get('approvalStatus') ?? ''

    const bills = await prisma.bill.findMany({
      where: {
        AND: [
          { companyId },
          search ? {
            OR: [
              { billNo: { contains: search } },
              { vendor: { name: { contains: search } } },
            ],
          } : {},
          status ? { status } : {},
          approvalStatus ? { approvalStatus } : {},
        ],
      },
      include: { vendor: { select: { name: true } }, lines: true },
      orderBy: { date: 'desc' },
    })

    return Response.json(bills)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const {
      vendorId, date, dueDate, currency, lines, notes, reference,
      approvalStatus, purchaseOrderId, isRecurring, recurringDay, status,
    } = body

    if (!vendorId || !date || !dueDate || !lines?.length) {
      return Response.json({ error: 'vendorId, date, dueDate, lines are required' }, { status: 400 })
    }

    let subtotal = 0
    let taxAmount = 0
    const processedLines = lines.map((l: {
      description: string; quantity: number; unitPrice: number; taxRate: number
      accountId?: string; costCenterId?: string; inventoryItemId?: string
    }) => {
      const lineAmount = l.quantity * l.unitPrice
      const lineTax = lineAmount * (l.taxRate / 100)
      subtotal += lineAmount
      taxAmount += lineTax
      return { ...l, amount: lineAmount }
    })

    const total = subtotal + taxAmount
    const billNo = await getNextSequence('BILL', 'BILL-')
    const resolvedCurrency = await resolveTransactionCurrency(currency)
    const resolvedApprovalStatus = approvalStatus ?? 'PENDING'
    const billStatus = status ?? (resolvedApprovalStatus === 'APPROVED' ? 'RECEIVED' : 'DRAFT')

    const bill = await prisma.bill.create({
      data: {
        billNo,
        vendorId,
        date: new Date(date),
        dueDate: new Date(dueDate),
        currency: resolvedCurrency,
        subtotal,
        taxAmount,
        total,
        balance: total,
        notes,
        reference,
        status: billStatus,
        approvalStatus: resolvedApprovalStatus,
        purchaseOrderId: purchaseOrderId || null,
        isRecurring: isRecurring ?? false,
        recurringDay: recurringDay ?? null,
        createdById: user.id,
        lines: {
          create: processedLines.map((l: {
            description: string; quantity: number; unitPrice: number
            taxRate: number; amount: number; accountId?: string; costCenterId?: string; inventoryItemId?: string
          }) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            amount: l.amount,
            accountId: l.accountId || null,
            costCenterId: l.costCenterId || null,
            inventoryItemId: l.inventoryItemId || null,
          })),
        },
      },
      include: { vendor: { select: { name: true } }, lines: true },
    })

    const workflow = await maybeStartWorkflow({
      entityType: 'BILL',
      entityId: bill.id,
      entityLabel: bill.billNo,
      amount: total,
      submittedById: user.id,
      companyId,
    })

    if (billStatus === 'RECEIVED' && !workflow) {
      await postBillToLedger(bill.id, companyId)
    }

    await logAudit({ companyId, userId: user.id, action: 'BILL_CREATED', entityType: 'bill', entityId: bill.id, details: { billNo: bill.billNo, total } })

    return Response.json(bill, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
