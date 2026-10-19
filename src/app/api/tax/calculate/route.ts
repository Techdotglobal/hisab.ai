import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { computeDocumentLineTaxes, TaxValidationError } from '@/lib/tax/engine'

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    const lines = Array.isArray(body.lines) ? body.lines : []
    if (lines.length === 0) {
      return Response.json({ error: 'lines are required' }, { status: 400 })
    }

    const result = await computeDocumentLineTaxes(lines, {
      customerId: body.customerId ?? null,
      vendorId: body.vendorId ?? null,
      regionCode: body.regionCode ?? null,
      documentType: body.documentType,
      entryDate: body.entryDate ? new Date(body.entryDate) : undefined,
    })

    return Response.json(result)
  } catch (error) {
    if (error instanceof TaxValidationError) {
      return Response.json({ error: error.message, code: error.code }, { status: 400 })
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('tax.view', handlePost)
