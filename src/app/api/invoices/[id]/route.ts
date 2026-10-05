import { requireAuth } from '@/lib/auth'
import { postInvoiceToLedger } from '@/lib/accounting/document-posting'
import { getInvoiceRepository } from '@/lib/db/provider'
import { resolveCompanyId } from '@/lib/tenant'
import { validateExpiryDate, validateInvoicePayload } from '@/lib/invoices/validation'
import { POSTED_INVOICE_DELETE_ERROR, POSTED_INVOICE_EDIT_ERROR } from '@/lib/invoices/posted-guard'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const invoice = await getInvoiceRepository().findById(id)
    if (!invoice) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(invoice)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const body = await request.json()
    const existing = await getInvoiceRepository().findById(id)

    if (body.date || body.expiryDate !== undefined) {
      const expiryError = validateExpiryDate(
        body.date ?? existing?.date ?? new Date(),
        body.expiryDate,
      )
      if (expiryError) return Response.json({ error: expiryError }, { status: 400 })
    }

    if (body.lines) {
      const validationError = validateInvoicePayload({
        customerId: body.customerId ?? existing?.customerId,
        date: body.date ?? (existing?.date ? String(existing.date) : undefined),
        dueDate: body.dueDate ?? (existing?.dueDate ? String(existing.dueDate) : undefined),
        expiryDate: body.expiryDate,
        taxCalculationMethod: body.taxCalculationMethod,
        lines: body.lines,
      })
      if (validationError) return Response.json({ error: validationError }, { status: 400 })
    }

    const invoice = await getInvoiceRepository().update(id, {
      customerId: body.customerId,
      date: body.date,
      dueDate: body.dueDate,
      expiryDate: body.expiryDate !== undefined ? body.expiryDate : undefined,
      currency: body.currency,
      taxCalculationMethod: body.taxCalculationMethod,
      paymentTermId: body.paymentTermId !== undefined ? body.paymentTermId : undefined,
      lines: body.lines,
      notes: body.notes,
      terms: body.terms,
      status: body.status,
    })

    if (body.status === 'SENT' && existing?.status !== 'SENT') {
      const companyId = await resolveCompanyId()
      await postInvoiceToLedger(id, companyId)
    }

    return Response.json(invoice)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof Error && error.message === 'Invoice not found') {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    if (error instanceof Error && error.message === 'Cannot edit paid invoice') {
      return Response.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof Error && error.message === POSTED_INVOICE_EDIT_ERROR) {
      return Response.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof Error && error.message === 'Customer not found') {
      return Response.json({ error: error.message }, { status: 400 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    await getInvoiceRepository().delete(id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof Error && error.message === 'Invoice not found') {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    if (error instanceof Error && (error.message === 'Cannot delete paid invoice' || error.message === POSTED_INVOICE_DELETE_ERROR)) {
      return Response.json({ error: error.message }, { status: 400 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
