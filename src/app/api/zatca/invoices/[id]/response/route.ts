import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getInvoiceZatcaResponse } from '@/lib/zatca/submission/status'

/**
 * GET /api/zatca/invoices/:id/response
 * Returns ZATCA submission response metadata (no secrets).
 */
async function handleGet(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params
    const response = await getInvoiceZatcaResponse(id)
    if (!response) {
      return Response.json({ error: 'Invoice not found' }, { status: 404 })
    }
    return Response.json(response)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
