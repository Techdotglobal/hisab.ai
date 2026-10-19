import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getInvoiceRepository } from '@/lib/db/provider'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

function mapSchedule(row: Record<string, unknown>, customer?: { name?: string } | null) {
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    customer: customer ? { name: customer.name ?? '' } : undefined,
    templateInvoiceId: row.template_invoice_id ? String(row.template_invoice_id) : null,
    frequency: String(row.frequency ?? 'MONTHLY'),
    nextRunDate: row.next_run_date,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  }
}

function advanceNextRunDate(current: Date, frequency: string): Date {
  const next = new Date(current)
  switch (frequency.toUpperCase()) {
    case 'WEEKLY':
      next.setDate(next.getDate() + 7)
      break
    case 'QUARTERLY':
      next.setMonth(next.getMonth() + 3)
      break
    case 'YEARLY':
      next.setFullYear(next.getFullYear() + 1)
      break
    case 'MONTHLY':
    default:
      next.setMonth(next.getMonth() + 1)
      break
  }
  return next
}

async function runDueSchedules(companyId: string, userId: string) {
  const client = createAdminClient()
  const now = new Date().toISOString()

  const { data: schedules, error } = await client
    .from('recurring_invoice_schedules')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .lte('next_run_date', now)

  if (error) throw error

  const created: Array<{ scheduleId: string; invoiceId: string }> = []

  for (const schedule of schedules ?? []) {
    if (!schedule.template_invoice_id) continue

    const template = await getInvoiceRepository().findById(String(schedule.template_invoice_id))
    if (!template?.lines?.length) continue

    const issueDate = new Date()
    const dueDate = new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000)

    const invoice = await getInvoiceRepository().create({
      customerId: template.customerId,
      date: issueDate.toISOString().split('T')[0],
      dueDate: dueDate.toISOString().split('T')[0],
      currency: template.currency,
      notes: template.notes,
      terms: template.terms,
      isRecurring: true,
      lines: template.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxRate: line.taxRate,
        accountId: line.accountId,
        costCenterId: line.costCenterId,
      })),
      createdById: userId,
    })

    const nextRun = advanceNextRunDate(new Date(String(schedule.next_run_date)), String(schedule.frequency))
    await client
      .from('recurring_invoice_schedules')
      .update({ next_run_date: nextRun.toISOString() })
      .eq('company_id', companyId)
      .eq('id', schedule.id)

    created.push({ scheduleId: String(schedule.id), invoiceId: invoice.id })
  }

  return created
}

async function handleGet() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const client = createAdminClient()

    const { data, error } = await client
      .from('recurring_invoice_schedules')
      .select('*, customers(name)')
      .eq('company_id', companyId)
      .order('next_run_date', { ascending: true })

    if (error) throw error

    return Response.json((data ?? []).map((row) => {
      const customer = row.customers as { name?: string } | null
      return mapSchedule(row, customer)
    }))
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
    const companyId = await resolveCompanyId()
    const body = await request.json()

    if (body.action === 'run') {
      const created = await runDueSchedules(companyId, user.id)
      return Response.json({ created, count: created.length })
    }

    const { customerId, templateInvoiceId, frequency, nextRunDate, isActive } = body
    if (!customerId || !nextRunDate) {
      return Response.json({ error: 'customerId and nextRunDate are required' }, { status: 400 })
    }

    const client = createAdminClient()

    const { data: customer, error: customerError } = await client
      .from('customers')
      .select('id')
      .eq('company_id', companyId)
      .eq('id', customerId)
      .maybeSingle()
    if (customerError) throw customerError
    if (!customer) return Response.json({ error: 'Customer not found' }, { status: 400 })

    if (templateInvoiceId) {
      const template = await getInvoiceRepository().findById(templateInvoiceId)
      if (!template) return Response.json({ error: 'Template invoice not found' }, { status: 400 })
    }

    const { data: schedule, error } = await client
      .from('recurring_invoice_schedules')
      .insert({
        company_id: companyId,
        customer_id: customerId,
        template_invoice_id: templateInvoiceId ?? null,
        frequency: frequency ?? 'MONTHLY',
        next_run_date: new Date(nextRunDate).toISOString(),
        is_active: isActive ?? true,
      })
      .select('*')
      .single()

    if (error) throw error
    return Response.json(mapSchedule(schedule), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
export const POST = guarded('invoices.edit', handlePost)
