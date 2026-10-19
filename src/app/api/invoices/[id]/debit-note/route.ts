import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getInvoiceRepository } from '@/lib/db/provider'

async function createAdjustment(
  request: Request,
  params: Promise<{ id: string }>,
  adjustmentType: 'CREDIT_NOTE' | 'DEBIT_NOTE',
) {
  const user = await requireAuth()
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const { date, dueDate, lines, notes } = body

  if (!date || !dueDate || !lines?.length) {
    return Response.json({ error: 'date, dueDate, and lines are required' }, { status: 400 })
  }

  const invoice = await getInvoiceRepository().createAdjustment({
    sourceInvoiceId: id,
    adjustmentType,
    date,
    dueDate,
    lines,
    notes,
    createdById: user.id,
  })

  return Response.json(invoice, { status: 201 })
}

/**
 * POST /api/invoices/:id/debit-note
 */
async function handlePost(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return await createAdjustment(request, context.params, 'DEBIT_NOTE')
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      return Response.json({ error: error.message }, { status: 404 })
    }
    if (error instanceof Error && /only be created from/i.test(error.message)) {
      return Response.json({ error: error.message }, { status: 400 })
    }
    return Response.json({ error: String(error) }, { status: 422 })
  }
}

export const POST = guarded('invoices.edit', handlePost)
