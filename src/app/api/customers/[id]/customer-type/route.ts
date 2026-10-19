import { guarded } from '@/lib/permissions/guard'
import { productParityErrorResponse } from '@/lib/product-parity/api-errors'
import { requireAccountingWrite } from '@/lib/product-parity/permissions'
import { createAdminClient } from '@/lib/supabase/admin'

async function handlePatch(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAccountingWrite()
    const { id } = await params
    const { customerTypeId } = await request.json()
    const db = createAdminClient()
    if (customerTypeId) {
      const { data, error } = await db.from('customer_types').select('id').eq('company_id', user.companyId).eq('id', customerTypeId).eq('is_active', true).is('deleted_at', null).maybeSingle()
      if (error) throw error
      if (!data) throw new Error('Customer type not found.')
    }
    const { data, error } = await db.from('customers').update({ customer_type_id: customerTypeId || null, updated_at: new Date().toISOString() }).eq('company_id', user.companyId).eq('id', id).is('deleted_at', null).select('id,customer_type_id').single()
    if (error) throw error
    return Response.json(data)
  } catch (error) { return productParityErrorResponse(error) }
}

export const PATCH = guarded('customers.edit', handlePatch)
