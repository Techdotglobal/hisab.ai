import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const entry = await prisma.journalEntry.findUnique({
      where: { id, companyId: user.companyId },
      include: { lines: { include: { account: true, costCenter: true } }, createdBy: { select: { name: true } } },
    })
    if (!entry) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(entry)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const body = await request.json()
    const { date, description, reference, lines } = body

    const existing = await prisma.journalEntry.findUnique({ where: { id, companyId: user.companyId } })
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
    if (existing.status === 'POSTED') return Response.json({ error: 'Cannot edit posted entry' }, { status: 400 })

    const totalDebit = lines.reduce((s: number, l: { debit: number }) => s + (l.debit || 0), 0)
    const totalCredit = lines.reduce((s: number, l: { credit: number }) => s + (l.credit || 0), 0)

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return Response.json({ error: 'Debits must equal credits' }, { status: 400 })
    }

    await prisma.journalLine.deleteMany({ where: { journalId: id } })

    const entry = await prisma.journalEntry.update({
      where: { id, companyId: user.companyId },
      data: {
        date: new Date(date),
        description,
        reference,
        totalDebit,
        totalCredit,
        lines: {
          create: lines.map((l: {
            accountId: string; costCenterId?: string; description?: string;
            debit?: number; credit?: number; taxRate?: number
          }) => ({
            accountId: l.accountId,
            costCenterId: l.costCenterId || null,
            description: l.description,
            debit: l.debit || 0,
            credit: l.credit || 0,
            taxRate: l.taxRate || 0,
          })),
        },
      },
      include: { lines: { include: { account: true } } },
    })

    return Response.json(entry)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const entry = await prisma.journalEntry.findUnique({ where: { id, companyId: user.companyId } })
    if (entry?.status === 'POSTED') return Response.json({ error: 'Cannot delete posted entry' }, { status: 400 })
    await prisma.journalEntry.delete({ where: { id, companyId: user.companyId } })
    return Response.json({ success: true })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
