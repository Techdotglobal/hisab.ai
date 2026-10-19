import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { processZatcaInvoice } from '@/lib/zatca'

/**
 * Temporary Day 3 test endpoint — generates and persists invoice hash.
 *
 * GET /api/zatca/invoices/:id/hash
 */
async function handleGet(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params

    const result = await processZatcaInvoice(id, { persistHash: true })

    if (!result) {
      return Response.json({ error: 'Invoice or company settings not found' }, { status: 404 })
    }

    if (!result.validation.valid) {
      return Response.json(
        { error: 'ZATCA validation failed', validation: result.validation },
        { status: 422 },
      )
    }

    return Response.json({
      invoiceId: id,
      hash: result.hash,
      previousHash: result.previousHash,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
