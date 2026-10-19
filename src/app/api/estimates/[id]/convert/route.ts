import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getInvoiceRepository } from '@/lib/db/provider'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const client = createAdminClient()

    const { data: estimate, error } = await client
      .from('estimates')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    if (!estimate) return Response.json({ error: 'Estimate not found' }, { status: 404 })
    if (estimate.status === 'CONVERTED') {
      return Response.json({ error: 'Estimate already converted' }, { status: 400 })
    }

    const { data: lines, error: lineError } = await client
      .from('estimate_lines')
      .select('*')
      .eq('company_id', companyId)
      .eq('estimate_id', id)

    if (lineError) throw lineError
    if (!lines?.length) return Response.json({ error: 'Estimate has no lines' }, { status: 400 })

    const issueDate = body.date ? new Date(body.date) : new Date(String(estimate.date))
    const dueDate = body.dueDate
      ? new Date(body.dueDate)
      : new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000)

    const invoice = await getInvoiceRepository().create({
      customerId: String(estimate.customer_id),
      date: issueDate.toISOString().split('T')[0],
      dueDate: dueDate.toISOString().split('T')[0],
      currency: String(estimate.currency ?? 'SAR'),
      notes: body.notes ?? (estimate.notes ? `Converted from ${estimate.estimate_no}` : `Converted from ${estimate.estimate_no}`),
      terms: body.terms ?? 'Net 30',
      lines: lines.map((line) => ({
        description: String(line.description),
        quantity: Number(line.quantity),
        unitPrice: Number(line.unit_price),
        taxRate: Number(line.tax_rate),
        accountId: line.account_id ? String(line.account_id) : null,
      })),
      createdById: user.id,
    })

    const { error: updateError } = await client
      .from('estimates')
      .update({ status: 'CONVERTED', updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', id)

    if (updateError) throw updateError

    if (body.send === true) {
      await getInvoiceRepository().update(invoice.id, { status: 'SENT' })
      const { postInvoiceToLedger } = await import('@/lib/accounting/document-posting')
      await postInvoiceToLedger(invoice.id, companyId)
    }

    const result = body.send === true
      ? await getInvoiceRepository().findById(invoice.id)
      : invoice

    return Response.json({ invoice: result, estimateId: id }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof Error && error.message === 'Customer not found') {
      return Response.json({ error: error.message }, { status: 400 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('invoices.edit', handlePost)
