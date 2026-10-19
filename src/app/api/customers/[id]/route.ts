import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getCustomerRepository } from '@/lib/db/provider'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const customer = await getCustomerRepository().findById(id)
    if (!customer) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(customer)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const body = await request.json()
    const customer = await getCustomerRepository().update(id, {
      name: body.name,
      email: body.email,
      phone: body.phone,
      address: body.address,
      city: body.city,
      country: body.country,
      taxId: body.taxId,
      creditLimit: body.creditLimit,
      paymentTerms: body.paymentTerms,
      isActive: body.isActive,
    })
    return Response.json(customer)
  } catch (error) {
    if (error instanceof Error && error.message === 'Customer not found') {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    await getCustomerRepository().delete(id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Customer not found') {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('customers.view', handleGet)
export const PUT = guarded('customers.edit', handlePut)
export const DELETE = guarded('customers.edit', handleDelete)
