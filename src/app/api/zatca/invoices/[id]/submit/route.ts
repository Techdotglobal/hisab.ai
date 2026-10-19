import { guarded } from '@/lib/permissions/guard'
import { requireZatcaSubmit } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { ZatcaError } from '@/lib/zatca/errors'
import { submitInvoice } from '@/lib/zatca/submission'

/**
 * POST /api/zatca/invoices/:id/submit
 * Full ZATCA submission workflow for an invoice.
 */
async function handlePost(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireZatcaSubmit()
    const { id } = await params
    const result = await submitInvoice(id, {
      userId: user.id,
      userName: user.name,
    })
    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof ZatcaForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 })
    }
    if (error instanceof ZatcaError) {
      return Response.json({
        error: error.message,
        code: error.code,
        diagnostic: error.diagnostic,
      }, { status: 422 })
    }
    return Response.json({ error: String(error) }, { status: 422 })
  }
}

export const POST = guarded('invoices.edit', handlePost)
