import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { processZatcaInvoice } from '@/lib/zatca'

/**
 * Temporary Day 2/3 test endpoint — generates ZATCA-oriented UBL 2.1 XML and persists hash.
 *
 * GET /api/zatca/invoices/:id/xml
 *   ?format=xml   (default) — returns application/xml
 *   ?format=json  — returns { xml, validation, document, hash, previousHash }
 */
async function handleGet(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const format = searchParams.get('format') ?? 'xml'

    const result = await processZatcaInvoice(id, { persistHash: true })

    if (!result) {
      return Response.json({ error: 'Invoice or company settings not found' }, { status: 404 })
    }

    if (!result.validation.valid) {
      return Response.json(
        {
          error: 'ZATCA validation failed',
          validation: result.validation,
        },
        { status: 422 },
      )
    }

    if (format === 'json') {
      return Response.json({
        xml: result.xml,
        validation: result.validation,
        document: result.document,
        hash: result.hash,
        previousHash: result.previousHash,
      })
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `inline; filename="${result.document.invoiceNumber}-zatca.xml"`,
      'X-ZATCA-Hash': result.hash,
    }

    if (result.previousHash) {
      headers['X-ZATCA-Previous-Hash'] = result.previousHash
    }

    if (result.validation.warnings.length > 0) {
      headers['X-ZATCA-Warnings'] = String(result.validation.warnings.length)
    }

    return new Response(result.xml, { status: 200, headers })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
