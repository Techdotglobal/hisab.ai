import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { generateQrDataUrl, loadZatcaInvoiceById } from '@/lib/zatca'

/**
 * Temporary Day 3 test endpoint — generates TLV QR payload and PNG data URL.
 *
 * GET /api/zatca/invoices/:id/qr
 */
async function handleGet(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params

    const loaded = await loadZatcaInvoiceById(id)
    if (!loaded) {
      return Response.json({ error: 'Invoice or company settings not found' }, { status: 404 })
    }

    const result = await generateQrDataUrl(loaded.input)

    if (!result.validation.valid) {
      return Response.json(
        { error: 'QR validation failed', validation: result.validation },
        { status: 422 },
      )
    }

    return Response.json({
      payload: result.payload,
      qrDataUrl: result.qrDataUrl,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
