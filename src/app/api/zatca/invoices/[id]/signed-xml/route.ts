import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { loadInvoiceForZatca } from '@/lib/zatca/persistence'

/**
 * GET /api/zatca/invoices/:id/signed-xml
 * Reads signed XML from the same persistence layer used by submission (Supabase repository).
 */
async function handleGet(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params

    const invoice = await loadInvoiceForZatca(id)

    if (!invoice) {
      return Response.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (!invoice.signedXml) {
      return Response.json(
        { error: 'Signed XML not available. Submit invoice to ZATCA first (signed XML is stored even if submission fails).' },
        { status: 404 },
      )
    }

    return new Response(invoice.signedXml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `inline; filename="${invoice.invoiceNo}-signed.xml"`,
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
