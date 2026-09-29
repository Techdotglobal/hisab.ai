import { requireAuth } from '@/lib/auth'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { prisma } from '@/lib/prisma'
import { getNextSequence } from '@/lib/sequences'
import { resolveCompanyId } from '@/lib/tenant'
import { maybeStartWorkflow } from '@/lib/workflow/integration'

export async function GET(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? ''
    const status = searchParams.get('status') ?? ''

    const expenses = await prisma.expense.findMany({
      where: {
        AND: [
          { companyId },
          search ? {
            OR: [
              { expenseNo: { contains: search } },
              { description: { contains: search } },
              { category: { contains: search } },
            ],
          } : {},
          status ? { status } : {},
        ],
      },
      include: { createdBy: { select: { name: true } }, lines: true },
      orderBy: { date: 'desc' },
    })

    return Response.json(expenses)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()
    const { date, description, category, currency, lines, receiptId } = body

    if (!date || !description || !category || !lines?.length) {
      return Response.json({ error: 'date, description, category, lines are required' }, { status: 400 })
    }

    let total = 0
    let taxAmount = 0
    const processedLines = lines.map((l: { description: string; amount: number; taxRate: number; accountId?: string }) => {
      const lineTax = l.amount * (l.taxRate / 100)
      total += l.amount
      taxAmount += lineTax
      return l
    })

    const expenseNo = await getNextSequence('EXPENSE', 'EXP-')
    const resolvedCurrency = await resolveTransactionCurrency(currency)

    const expense = await prisma.expense.create({
      data: {
        expenseNo,
        date: new Date(date),
        description,
        category,
        currency: resolvedCurrency,
        total,
        taxAmount,
        receiptId: receiptId || null,
        createdById: user.id,
        lines: {
          create: processedLines.map((l: { description: string; amount: number; taxRate: number; accountId?: string }) => ({
            description: l.description,
            amount: l.amount,
            taxRate: l.taxRate || 0,
            accountId: l.accountId || null,
          })),
        },
      },
      include: { lines: true, createdBy: { select: { name: true } } },
    })

    const companyId = await resolveCompanyId()
    await maybeStartWorkflow({
      entityType: 'EXPENSE',
      entityId: expense.id,
      entityLabel: expense.expenseNo,
      amount: total,
      submittedById: user.id,
      companyId,
    })

    return Response.json(expense, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
