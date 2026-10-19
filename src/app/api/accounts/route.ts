import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getAccountRepository } from '@/lib/db/provider'
import { prisma } from '@/lib/prisma'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? undefined
    const type = searchParams.get('type') ?? undefined
    const accounts = await getAccountRepository().findMany({ search, type })
    return Response.json(accounts)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    const { accountNo, name, fullName, parentNo, accountType, subType, description } = body

    if (!accountNo || !name || !accountType || !subType) {
      return Response.json({ error: 'accountNo, name, accountType, subType are required' }, { status: 400 })
    }

    const account = await prisma.chartOfAccount.create({
      data: { accountNo, name, fullName: fullName || name, parentNo, accountType, subType, description },
    })

    return Response.json(account, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('accounts.view', handleGet)
export const POST = guarded('accounts.manage', handlePost)
