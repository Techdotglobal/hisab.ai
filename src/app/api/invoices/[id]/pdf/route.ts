import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { generateInvoicePdf } from '@/lib/invoices/pdf'

/**
 * GET /api/invoices/:id/pdf
 * Generates a company-branded printable tax invoice PDF.
 * ?disposition=inline — open in browser (View PDF)
 * ?disposition=attachment — download (default)
 */
async function handleGet(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const inline = searchParams.get('disposition') === 'inline'

    const { pdf: buffer, filename } = await generateInvoicePdf(id)

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
        'Cache-Control': 'private, no-cache',
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof Error && error.message === 'Invoice not found') {
      return Response.json({ error: 'Invoice not found' }, { status: 404 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
