import { guarded } from '@/lib/permissions/guard'
import { requireZatcaAdmin } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { submitComplianceInvoice } from '@/lib/zatca/api/compliance-invoices'
import { processZatcaInvoice, loadZatcaInvoiceById } from '@/lib/zatca/invoice-service'
import { signAndEmbedPhase2Qr } from '@/lib/zatca/invoice-signing'
import { loadComplianceSigningCredentials } from '@/lib/zatca/signature/certificate'
import { getSettingsRepository } from '@/lib/db/provider'

/**
 * POST /api/zatca/invoices/[id]/compliance-check
 * Submits a signed invoice to ZATCA /compliance/invoices (pre-production CSID step).
 */
async function handlePost(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireZatcaAdmin()
    const { id } = await params

    const settings = await getSettingsRepository().findFirst()
    if (!settings) {
      return Response.json({ error: 'Company settings not found' }, { status: 404 })
    }

    const processed = await processZatcaInvoice(id, { persistHash: true })
    if (!processed?.validation.valid) {
      return Response.json({ error: 'Validation failed', validation: processed?.validation }, { status: 422 })
    }

    const loaded = await loadZatcaInvoiceById(id)
    if (!loaded) {
      return Response.json({ error: 'Invoice not found' }, { status: 404 })
    }

    const creds = await loadComplianceSigningCredentials(settings.zatcaEnvironment)
    const { signedXml, invoiceHashHex } = signAndEmbedPhase2Qr(
      processed.xml,
      loaded.input,
      creds.certificatePem,
      creds.privateKeyPem,
    )

    const result = await submitComplianceInvoice({
      environment: settings.zatcaEnvironment,
      invoiceHash: invoiceHashHex,
      uuid: processed.document.uuid,
      signedXml,
    })

    return Response.json({
      invoiceId: id,
      requestId: result.requestId,
      validationStatus: result.validationStatus,
      responseMessage: result.responseMessage,
      rawResponse: result.rawResponse,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof ZatcaForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 })
    }
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

export const POST = guarded('invoices.edit', handlePost)
