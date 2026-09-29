import { requireAuth } from '@/lib/auth'
import { processZatcaInvoice } from '@/lib/zatca/invoice-service'
import { validateXmlCompliance } from '@/lib/zatca/validation/xml-compliance'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'

/**
 * GET /api/zatca/invoices/[id]/compliance
 * Offline XML compliance review against ZATCA UBL requirements.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params

    const invoice = await prisma.invoice.findUnique({
      where: { id, companyId },
      select: { id: true, invoiceType: true },
    })
    if (!invoice) {
      return Response.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const processed = await processZatcaInvoice(id, { persistHash: false })
    if (!processed?.validation.valid) {
      return Response.json({
        error: 'Invoice validation failed',
        validation: processed?.validation,
      }, { status: 422 })
    }

    const compliance = validateXmlCompliance({
      xml: processed.xml,
      invoiceType: invoice.invoiceType,
    })

    return Response.json({
      invoiceId: id,
      invoiceType: invoice.invoiceType,
      hash: processed.hash,
      compliance,
      xmlLength: processed.xml.length,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
