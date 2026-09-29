import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const receipt = await prisma.receipt.findUnique({ where: { id, companyId: user.companyId } })
    if (!receipt) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(receipt)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const body = await request.json()
    const receipt = await prisma.receipt.update({
      where: { id, companyId: user.companyId },
      data: {
        vendor: body.vendor,
        amount: body.amount,
        date: body.date ? new Date(body.date) : undefined,
        description: body.description,
        status: body.status,
      },
    })
    return Response.json(receipt)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    await prisma.receipt.delete({ where: { id, companyId: user.companyId } })
    return Response.json({ success: true })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
