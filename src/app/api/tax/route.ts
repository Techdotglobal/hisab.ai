import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'

export async function GET() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const taxRates = await prisma.taxRate.findMany({ where: { companyId }, orderBy: { rate: 'desc' } })
    return Response.json(taxRates)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const rate = Number(body.rate)

    if (!name || Number.isNaN(rate) || rate < 0) {
      return Response.json({ error: 'name and a non-negative rate are required' }, { status: 400 })
    }

    const taxRate = await prisma.taxRate.create({
      data: {
        name,
        rate,
        type: body.type || 'VAT',
        isDefault: body.isDefault || false,
        taxMode: body.taxMode,
        isReverseCharge: body.isReverseCharge,
        isWithholding: body.isWithholding,
        regionCode: body.regionCode,
      },
    })
    return Response.json(taxRate, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
