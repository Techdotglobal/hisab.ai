import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'
import { writeFile } from 'fs/promises'
import { join } from 'path'

export async function GET() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const receipts = await prisma.receipt.findMany({
      where: { companyId },
      include: { uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return Response.json(receipts)
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
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return Response.json({ error: 'No file provided' }, { status: 400 })
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    const fileName = `${Date.now()}-${file.name.replace(/\s/g, '_')}`
    const filePath = join(process.cwd(), 'public', 'receipts', fileName)

    await writeFile(filePath, buffer)

    const receipt = await prisma.receipt.create({
      data: {
        fileName: file.name,
        filePath: `/receipts/${fileName}`,
        mimeType: file.type,
        vendor: formData.get('vendor') as string || null,
        amount: formData.get('amount') ? parseFloat(formData.get('amount') as string) : null,
        description: formData.get('description') as string || null,
        uploadedById: user.id,
        status: 'UNPROCESSED',
      },
    })

    return Response.json(receipt, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
