import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getPayrollRepository } from '@/lib/db/provider'
import { prisma } from '@/lib/prisma'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const payroll = await getPayrollRepository().findById(id)
    if (!payroll) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(payroll)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const body = await request.json()
    const payroll = await prisma.payrollEntry.update({
      where: { id },
      data: {
        notes: body.notes,
        status: body.status,
        paidAt: body.status === 'PAID' ? new Date() : undefined,
      },
    })
    return Response.json(payroll)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('payroll.view', handleGet)
export const PUT = guarded('payroll.manage', handlePut)
