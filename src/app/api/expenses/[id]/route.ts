import { requireAuth } from '@/lib/auth'
import { postExpenseToLedger } from '@/lib/accounting/document-posting'
import { logAudit } from '@/lib/audit/log'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { prisma } from '@/lib/prisma'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const expense = await prisma.expense.findUnique({
      where: { id, companyId: user.companyId },
      include: { lines: { include: { account: true } }, receipt: true },
    })
    if (!expense) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(expense)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const body = await request.json()

    const existing = await prisma.expense.findUnique({
      where: { id, companyId: user.companyId },
      include: { lines: true },
    })
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const isPartialUpdate = !body.lines || !Array.isArray(body.lines) || body.lines.length === 0

    if (isPartialUpdate) {
      const resolvedCurrency = body.currency !== undefined
        ? await resolveTransactionCurrency(body.currency)
        : existing.currency

      const expense = await prisma.expense.update({
        where: { id, companyId: user.companyId },
        data: {
          date: body.date ? new Date(body.date) : existing.date,
          description: body.description ?? existing.description,
          category: body.category ?? existing.category,
          currency: resolvedCurrency,
          receiptId: body.receiptId !== undefined ? (body.receiptId || null) : existing.receiptId,
          status: body.status ?? existing.status,
        },
        include: { lines: true },
      })

      if (body.status === 'APPROVED' && existing.status !== 'APPROVED') {
        await postExpenseToLedger(id, user.companyId)
        await logAudit({
          action: 'APPROVE',
          entityType: 'expense',
          entityId: id,
          userId: user.id,
          companyId: user.companyId,
        })
      }

      return Response.json(expense)
    }

    let total = 0
    let taxAmount = 0
    const processedLines = body.lines.map((l: { description: string; amount: number; taxRate: number; accountId?: string }) => {
      const lineTax = l.amount * (l.taxRate / 100)
      total += l.amount
      taxAmount += lineTax
      return l
    })

    await prisma.expenseLine.deleteMany({ where: { expenseId: id } })

    const resolvedCurrency = body.currency !== undefined
      ? await resolveTransactionCurrency(body.currency)
      : existing.currency

    const expense = await prisma.expense.update({
      where: { id, companyId: user.companyId },
      data: {
        date: body.date ? new Date(body.date) : existing.date,
        description: body.description ?? existing.description,
        category: body.category ?? existing.category,
        currency: resolvedCurrency,
        total,
        taxAmount,
        receiptId: body.receiptId !== undefined ? (body.receiptId || null) : existing.receiptId,
        status: body.status ?? existing.status,
        lines: {
          create: processedLines.map((l: { description: string; amount: number; taxRate: number; accountId?: string }) => ({
            description: l.description,
            amount: l.amount,
            taxRate: l.taxRate || 0,
            accountId: l.accountId || null,
          })),
        },
      },
      include: { lines: true },
    })

    if (body.status === 'APPROVED' && existing.status !== 'APPROVED') {
      await postExpenseToLedger(id, user.companyId)
      await logAudit({
        action: 'APPROVE',
        entityType: 'expense',
        entityId: id,
        userId: user.id,
        companyId: user.companyId,
      })
    }

    return Response.json(expense)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    await prisma.expense.delete({ where: { id, companyId: user.companyId } })
    return Response.json({ success: true })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
