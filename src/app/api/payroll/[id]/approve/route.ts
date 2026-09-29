import { requireAuth } from '@/lib/auth'
import { postPayrollToLedger } from '@/lib/accounting/document-posting'
import { logAudit } from '@/lib/audit/log'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const { prisma } = await import('@/lib/prisma')

    const existing = await prisma.payrollEntry.findUnique({ where: { id, companyId: user.companyId } })
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const payroll = await prisma.payrollEntry.update({
      where: { id, companyId: user.companyId },
      data: { status: 'APPROVED' },
    })

    await postPayrollToLedger(id, user.companyId)
    await logAudit({
      action: 'APPROVE',
      entityType: 'payroll',
      entityId: id,
      userId: user.id,
      companyId: user.companyId,
    })

    return Response.json(payroll)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
