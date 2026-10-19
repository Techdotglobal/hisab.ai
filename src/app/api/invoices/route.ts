import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getInvoiceRepository } from '@/lib/db/provider'
import { resolveCompanyId } from '@/lib/tenant'
import { maybeStartWorkflow } from '@/lib/workflow/integration'
import type { InvoiceListOptions } from '@/lib/db/repositories/invoice.repository.interface'
import { validateInvoicePayload } from '@/lib/invoices/validation'

function pickParam(searchParams: URLSearchParams, key: string) {
  const value = searchParams.get(key)
  return value && value.trim() ? value.trim() : undefined
}

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const options: InvoiceListOptions = {
      search: pickParam(searchParams, 'search'),
      status: pickParam(searchParams, 'status'),
      zatcaStatus: pickParam(searchParams, 'zatcaStatus'),
      invoiceType: pickParam(searchParams, 'invoiceType'),
      customerId: pickParam(searchParams, 'customerId'),
      datePreset: pickParam(searchParams, 'datePreset') as InvoiceListOptions['datePreset'],
      dateFrom: pickParam(searchParams, 'dateFrom'),
      dateTo: pickParam(searchParams, 'dateTo'),
      overdue: searchParams.get('overdue') === 'true' ? true : undefined,
      sortBy: pickParam(searchParams, 'sortBy') as InvoiceListOptions['sortBy'],
      sortDir: pickParam(searchParams, 'sortDir') as InvoiceListOptions['sortDir'],
      page: searchParams.get('page') ? Number(searchParams.get('page')) : undefined,
      limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
    }
    const result = await getInvoiceRepository().findMany(options)
    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()
    const {
      customerId,
      date,
      dueDate,
      expiryDate,
      currency,
      lines,
      notes,
      terms,
      isRecurring,
      recurringDay,
      taxCalculationMethod,
      paymentTermId,
    } = body

    const validationError = validateInvoicePayload({
      customerId,
      date,
      dueDate,
      expiryDate,
      taxCalculationMethod,
      lines,
      paymentTermId,
      terms,
    })
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 })
    }

    const invoice = await getInvoiceRepository().create({
      customerId,
      date,
      dueDate,
      expiryDate: expiryDate ?? null,
      currency,
      taxCalculationMethod,
      paymentTermId: paymentTermId ?? null,
      lines,
      notes,
      terms,
      isRecurring,
      recurringDay,
      createdById: user.id,
    })

    const companyId = await resolveCompanyId()
    await maybeStartWorkflow({
      entityType: 'INVOICE',
      entityId: invoice.id,
      entityLabel: invoice.invoiceNo,
      amount: Number(invoice.total ?? 0),
      submittedById: user.id,
      companyId,
    })

    return Response.json(invoice, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof Error && error.message === 'Customer not found') {
      return Response.json({ error: 'Customer not found' }, { status: 400 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
export const POST = guarded('invoices.edit', handlePost)
