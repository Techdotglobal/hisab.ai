import { requireAuth } from '@/lib/auth'
import { guarded } from '@/lib/permissions/guard'
import { getVendorRepository } from '@/lib/db/provider'
import { requireRole } from '@/lib/authz'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? undefined
    const vendors = await getVendorRepository().findMany({ search })
    return Response.json(vendors)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''

    if (!name) {
      return Response.json({ error: 'Supplier name is required' }, { status: 400 })
    }

    const vendor = await getVendorRepository().create({
      name,
      email: body.email,
      phone: body.phone,
      address: body.address,
      city: body.city,
      country: body.country,
      taxId: body.taxId,
      paymentTerms: body.paymentTerms || 30,
    })
    return Response.json(vendor, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('vendors.view', handleGet)
export const POST = guarded('vendors.edit', handlePost)
