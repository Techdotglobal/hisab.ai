import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getAccountRepository } from '@/lib/db/provider'
import { prisma } from '@/lib/prisma'
import { validateAccountDeletable, PostingValidationError } from '@/lib/accounting/validation'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const account = await getAccountRepository().findById(id)
    if (!account) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(account)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const body = await request.json()
    const account = await prisma.chartOfAccount.update({
      where: { id },
      data: {
        name: body.name,
        fullName: body.fullName,
        parentNo: body.parentNo,
        accountType: body.accountType,
        subType: body.subType,
        description: body.description,
        isActive: body.isActive,
      },
    })
    return Response.json(account)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    await validateAccountDeletable(id)
    await getAccountRepository().delete(id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof PostingValidationError) {
      return Response.json({ error: error.message, code: error.code }, { status: 409 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('accounts.view', handleGet)
export const PUT = guarded('accounts.manage', handlePut)
export const DELETE = guarded('accounts.manage', handleDelete)
