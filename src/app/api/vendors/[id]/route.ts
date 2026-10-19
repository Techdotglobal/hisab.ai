import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getVendorRepository } from '@/lib/db/provider'
import { logAudit } from '@/lib/audit/log'
import { requireRole } from '@/lib/authz'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const vendor = await getVendorRepository().findById(id)
    if (!vendor) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(vendor)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER'])
    const { id } = await params
    const body = await request.json()
    const supplier = await getVendorRepository().update(id, {
      name: body.name,
      email: body.email,
      phone: body.phone,
      address: body.address,
      city: body.city,
      country: body.country,
      taxId: body.taxId,
      paymentTerms: body.paymentTerms,
      isActive: body.isActive,
    })
    await logAudit({
      action: body.isActive === false ? 'SUPPLIER_INACTIVATED' : body.isActive === true ? 'SUPPLIER_ACTIVATED' : 'SUPPLIER_UPDATED',
      entityType: 'supplier', entityId: id,
    })
    return Response.json(supplier)
  } catch (error) {
    if (error instanceof Error && error.message === 'Vendor not found') {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    await getVendorRepository().delete(id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Vendor not found') {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('vendors.view', handleGet)
export const PUT = guarded('vendors.edit', handlePut)
export const DELETE = guarded('vendors.edit', handleDelete)
