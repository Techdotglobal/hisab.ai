import 'server-only'

import { processPurchaseLines } from '@/lib/api/db-transform'
import { logAudit } from '@/lib/audit/log'
import { processSalesLines } from '@/lib/sales/line-utils'
import { createAdminClient } from '@/lib/supabase/admin'
import { calculateNextExecutionDate } from './recurrence'
import {
  CUSTOMER_TRANSACTION_TYPES,
  FREQUENCIES,
  RECURRING_STATUSES,
  RECURRING_TYPES,
  TRANSACTION_TYPES,
  VENDOR_TRANSACTION_TYPES,
  type RecurringTemplateInput,
  type TransactionType,
} from './types'

type JsonRow = Record<string, unknown>
type GeneratedTransaction = { id: string; number: string }

const SORT_COLUMNS: Record<string, string> = {
  templateName: 'template_name', type: 'recurrence_type', transactionType: 'transaction_type',
  interval: 'created_at', previousDate: 'created_at', nextDate: 'created_at', amount: 'amount',
}

function asObject(value: unknown): JsonRow {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRow : {}
}

function asLines(value: unknown): JsonRow[] {
  return Array.isArray(value) ? value.filter((line): line is JsonRow => Boolean(line && typeof line === 'object')) : []
}

function normalizeInput(raw: unknown): RecurringTemplateInput {
  const body = asObject(raw)
  const schedule = asObject(body.schedule)
  const templateName = String(body.templateName ?? '').trim()
  const type = String(body.type ?? '').toUpperCase()
  const transactionType = String(body.transactionType ?? '').toUpperCase()
  const status = String(body.status ?? 'ACTIVE').toUpperCase()
  const frequency = String(schedule.frequency ?? 'MONTHLY').toUpperCase()
  const intervalCount = Math.max(1, Math.trunc(Number(schedule.intervalCount ?? 1)))
  const startDate = String(schedule.startDate ?? '')
  const endDate = schedule.endDate ? String(schedule.endDate) : null
  const nextRunDate = schedule.nextRunDate ? String(schedule.nextRunDate) : startDate

  if (!templateName) throw new Error('Template Name is required')
  if (!RECURRING_TYPES.includes(type as never)) throw new Error('Invalid recurring type')
  if (!TRANSACTION_TYPES.includes(transactionType as never)) throw new Error('Invalid transaction type')
  if (!RECURRING_STATUSES.includes(status as never)) throw new Error('Invalid status')
  if (!FREQUENCIES.includes(frequency as never)) throw new Error('Invalid frequency')
  if (!startDate || Number.isNaN(new Date(startDate).getTime())) throw new Error('A valid start date is required')
  if (endDate && new Date(endDate) < new Date(startDate)) throw new Error('End date must be on or after start date')

  const customerId = body.customerId ? String(body.customerId) : null
  const vendorId = body.vendorId ? String(body.vendorId) : null
  if (CUSTOMER_TRANSACTION_TYPES.has(transactionType as TransactionType) && !customerId) throw new Error('Customer is required for this transaction type')
  if (VENDOR_TRANSACTION_TYPES.has(transactionType as TransactionType) && !vendorId) throw new Error('Supplier is required for this transaction type')

  return {
    templateName, type: type as RecurringTemplateInput['type'], transactionType: transactionType as TransactionType,
    description: body.description ? String(body.description) : null,
    status: status as RecurringTemplateInput['status'], customerId, vendorId,
    currency: String(body.currency ?? 'SAR').toUpperCase(),
    referenceNumber: body.referenceNumber ? String(body.referenceNumber) : null,
    notes: body.notes ? String(body.notes) : null,
    amount: Math.max(0, Number(body.amount ?? 0)), transactionPayload: asObject(body.transactionPayload),
    schedule: {
      frequency: frequency as RecurringTemplateInput['schedule']['frequency'], intervalCount,
      customRule: asObject(schedule.customRule), startDate, endDate, nextRunDate,
      timeZone: String(schedule.timeZone ?? 'UTC'), maxRetries: Math.max(0, Math.trunc(Number(schedule.maxRetries ?? 3))),
    },
  }
}

function mapTemplate(row: JsonRow) {
  const scheduleValue = Array.isArray(row.schedule) ? row.schedule[0] : row.schedule
  const schedule = asObject(scheduleValue)
  const customer = asObject(row.customer)
  const vendor = asObject(row.vendor)
  return {
    id: String(row.id), templateName: String(row.template_name), type: String(row.recurrence_type),
    transactionType: String(row.transaction_type), description: row.description, status: String(row.status),
    customerId: row.customer_id, vendorId: row.vendor_id,
    partyName: customer.name ?? vendor.name ?? null, currency: String(row.currency),
    referenceNumber: row.reference_number, notes: row.notes, amount: Number(row.amount ?? 0),
    transactionPayload: asObject(row.transaction_payload), createdAt: row.created_at, updatedAt: row.updated_at,
    schedule: {
      id: schedule.id, frequency: schedule.frequency, intervalCount: Number(schedule.interval_count ?? 1),
      customRule: asObject(schedule.custom_rule), startDate: schedule.start_date, endDate: schedule.end_date,
      previousDate: schedule.previous_run_date, nextDate: schedule.next_run_date,
      timeZone: schedule.time_zone, retryCount: Number(schedule.retry_count ?? 0), maxRetries: Number(schedule.max_retries ?? 3),
      lastError: schedule.last_error,
    },
  }
}

async function assertParty(companyId: string, table: 'customers' | 'vendors', id: string | null | undefined) {
  if (!id) return
  const { data, error } = await createAdminClient().from(table).select('id').eq('company_id', companyId).eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) throw error
  if (!data) throw new Error(`${table === 'customers' ? 'Customer' : 'Supplier'} not found`)
}

export async function listRecurringTemplates(companyId: string, requestUrl: string) {
  const params = new URL(requestUrl).searchParams
  const page = Math.max(1, Number(params.get('page') ?? 1))
  const limit = Math.min(1000, Math.max(1, Number(params.get('limit') ?? 20)))
  const sortBy = SORT_COLUMNS[params.get('sortBy') ?? 'templateName'] ?? 'template_name'
  const ascending = params.get('sortDir') !== 'desc'
  const client = createAdminClient()
  let query = client.from('recurring_transaction_templates')
    .select('*, customer:customers(name), vendor:vendors(name), schedule:recurring_transaction_schedules!inner(*)', { count: 'exact' })
    .eq('company_id', companyId).is('deleted_at', null)

  const filters: Array<[string, string]> = [
    ['type', 'recurrence_type'], ['transactionType', 'transaction_type'], ['status', 'status'],
    ['customerId', 'customer_id'], ['vendorId', 'vendor_id'],
  ]
  for (const [param, column] of filters) {
    const value = params.get(param)?.trim()
    if (value) query = query.eq(column, value)
  }
  const interval = params.get('interval')
  const previousDate = params.get('previousDate')
  const nextDate = params.get('nextDate')
  if (interval) query = query.eq('recurring_transaction_schedules.frequency', interval)
  if (previousDate) query = query.gte('recurring_transaction_schedules.previous_run_date', `${previousDate}T00:00:00.000Z`).lt('recurring_transaction_schedules.previous_run_date', `${previousDate}T23:59:59.999Z`)
  if (nextDate) query = query.gte('recurring_transaction_schedules.next_run_date', `${nextDate}T00:00:00.000Z`).lt('recurring_transaction_schedules.next_run_date', `${nextDate}T23:59:59.999Z`)
  const search = params.get('search')?.trim()
  if (search) {
    const safeSearch = search.replaceAll(',', '')
    const [{ data: customerMatches }, { data: vendorMatches }] = await Promise.all([
      client.from('customers').select('id').eq('company_id', companyId).is('deleted_at', null).ilike('name', `%${safeSearch}%`).limit(100),
      client.from('vendors').select('id').eq('company_id', companyId).is('deleted_at', null).ilike('name', `%${safeSearch}%`).limit(100),
    ])
    const terms = [`template_name.ilike.%${safeSearch}%`, `description.ilike.%${safeSearch}%`, `transaction_type.ilike.%${safeSearch.replaceAll(' ', '_')}%`]
    if (customerMatches?.length) terms.push(`customer_id.in.(${customerMatches.map((row) => row.id).join(',')})`)
    if (vendorMatches?.length) terms.push(`vendor_id.in.(${vendorMatches.map((row) => row.id).join(',')})`)
    query = query.or(terms.join(','))
  }
  const scheduleSort: Record<string, string> = { interval: 'frequency', previousDate: 'previous_run_date', nextDate: 'next_run_date' }
  query = scheduleSort[params.get('sortBy') ?? '']
    ? query.order(scheduleSort[params.get('sortBy') ?? ''], { ascending, referencedTable: 'recurring_transaction_schedules' })
    : query.order(sortBy, { ascending })
  const { data, error, count } = await query.range((page - 1) * limit, page * limit - 1)
  if (error) throw error

  const items = (data ?? []).map((row) => mapTemplate(row as JsonRow))
  return { items, total: count ?? items.length, page, limit }
}

export async function getRecurringTemplate(companyId: string, id: string) {
  const { data, error } = await createAdminClient().from('recurring_transaction_templates')
    .select('*, customer:customers(name), vendor:vendors(name), schedule:recurring_transaction_schedules(*)')
    .eq('company_id', companyId).eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) throw error
  return data ? mapTemplate(data as JsonRow) : null
}

export async function createRecurringTemplate(companyId: string, userId: string, raw: unknown) {
  const input = normalizeInput(raw)
  await Promise.all([assertParty(companyId, 'customers', input.customerId), assertParty(companyId, 'vendors', input.vendorId)])
  const client = createAdminClient()
  const { data: template, error } = await client.from('recurring_transaction_templates').insert({
    company_id: companyId, template_name: input.templateName, recurrence_type: input.type,
    transaction_type: input.transactionType, description: input.description, status: input.status,
    customer_id: input.customerId, vendor_id: input.vendorId, currency: input.currency,
    reference_number: input.referenceNumber, notes: input.notes, amount: input.amount,
    transaction_payload: input.transactionPayload, created_by_id: userId, updated_by_id: userId,
  }).select('id').single()
  if (error) throw error
  const { error: scheduleError } = await client.from('recurring_transaction_schedules').insert({
    company_id: companyId, template_id: template.id, frequency: input.schedule.frequency,
    interval_count: input.schedule.intervalCount, custom_rule: input.schedule.customRule,
    start_date: new Date(input.schedule.startDate).toISOString(), end_date: input.schedule.endDate ? new Date(input.schedule.endDate).toISOString() : null,
    next_run_date: input.type === 'UNSCHEDULED' ? null : new Date(input.schedule.nextRunDate ?? input.schedule.startDate).toISOString(),
    time_zone: input.schedule.timeZone, max_retries: input.schedule.maxRetries,
  })
  if (scheduleError) {
    await client.from('recurring_transaction_templates').delete().eq('company_id', companyId).eq('id', template.id)
    throw scheduleError
  }
  await logAudit({ companyId, userId, action: 'CREATE', entityType: 'RECURRING_TRANSACTION', entityId: template.id, details: { templateName: input.templateName } })
  return getRecurringTemplate(companyId, template.id)
}

export async function updateRecurringTemplate(companyId: string, userId: string, id: string, raw: unknown) {
  const existing = await getRecurringTemplate(companyId, id)
  if (!existing) return null
  const input = normalizeInput(raw)
  await Promise.all([assertParty(companyId, 'customers', input.customerId), assertParty(companyId, 'vendors', input.vendorId)])
  const client = createAdminClient()
  const { error } = await client.from('recurring_transaction_templates').update({
    template_name: input.templateName, recurrence_type: input.type, transaction_type: input.transactionType,
    description: input.description, status: input.status, customer_id: input.customerId, vendor_id: input.vendorId,
    currency: input.currency, reference_number: input.referenceNumber, notes: input.notes,
    amount: input.amount, transaction_payload: input.transactionPayload, updated_by_id: userId,
  }).eq('company_id', companyId).eq('id', id).is('deleted_at', null)
  if (error) throw error
  const { error: scheduleError } = await client.from('recurring_transaction_schedules').update({
    frequency: input.schedule.frequency, interval_count: input.schedule.intervalCount, custom_rule: input.schedule.customRule,
    start_date: new Date(input.schedule.startDate).toISOString(), end_date: input.schedule.endDate ? new Date(input.schedule.endDate).toISOString() : null,
    next_run_date: input.type === 'UNSCHEDULED' ? null : new Date(input.schedule.nextRunDate ?? input.schedule.startDate).toISOString(),
    time_zone: input.schedule.timeZone, max_retries: input.schedule.maxRetries,
  }).eq('company_id', companyId).eq('template_id', id)
  if (scheduleError) throw scheduleError
  await logAudit({ companyId, userId, action: 'UPDATE', entityType: 'RECURRING_TRANSACTION', entityId: id, details: { before: existing, templateName: input.templateName } })
  return getRecurringTemplate(companyId, id)
}

export async function duplicateRecurringTemplate(companyId: string, userId: string, id: string) {
  const source = await getRecurringTemplate(companyId, id)
  if (!source) return null
  const client = createAdminClient()
  const baseName = `${source.templateName} (Copy)`
  const { data: matches, error } = await client.from('recurring_transaction_templates').select('template_name')
    .eq('company_id', companyId).is('deleted_at', null).ilike('template_name', `${source.templateName.replaceAll('%', '')} (Copy%`)
  if (error) throw error
  const existingNames = new Set((matches ?? []).map((row) => String(row.template_name).toLowerCase()))
  let copyName = baseName
  let suffix = 2
  while (existingNames.has(copyName.toLowerCase())) copyName = `${source.templateName} (Copy ${suffix++})`
  return createRecurringTemplate(companyId, userId, {
    ...source, templateName: copyName, status: 'PAUSED',
    schedule: { ...source.schedule, startDate: source.schedule.startDate, nextRunDate: source.schedule.nextDate },
  })
}

export async function softDeleteRecurringTemplate(companyId: string, userId: string, id: string) {
  const existing = await getRecurringTemplate(companyId, id)
  if (!existing) return false
  const { error } = await createAdminClient().from('recurring_transaction_templates')
    .update({ deleted_at: new Date().toISOString(), status: 'ARCHIVED', updated_by_id: userId })
    .eq('company_id', companyId).eq('id', id)
  if (error) throw error
  await logAudit({ companyId, userId, action: 'DELETE', entityType: 'RECURRING_TRANSACTION', entityId: id, details: { templateName: existing.templateName } })
  return true
}

export async function setRecurringStatus(companyId: string, userId: string, id: string, status: 'ACTIVE' | 'PAUSED') {
  const { data, error } = await createAdminClient().from('recurring_transaction_templates')
    .update({ status, updated_by_id: userId }).eq('company_id', companyId).eq('id', id).is('deleted_at', null).select('id').maybeSingle()
  if (error) throw error
  if (!data) return null
  await logAudit({ companyId, userId, action: status === 'ACTIVE' ? 'RESUME' : 'PAUSE', entityType: 'RECURRING_TRANSACTION', entityId: id })
  return getRecurringTemplate(companyId, id)
}

async function nextSequence(companyId: string, type: string, prefix: string) {
  const client = createAdminClient()
  const { data, error } = await client.from('sequences').select('id,next_no').eq('company_id', companyId).eq('type', type).maybeSingle()
  if (error) throw error
  if (!data) {
    const { error: insertError } = await client.from('sequences').insert({ company_id: companyId, type, prefix, next_no: 2 })
    if (insertError) throw insertError
    return `${prefix}00001`
  }
  const number = Number(data.next_no)
  const { error: updateError } = await client.from('sequences').update({ next_no: number + 1 }).eq('id', data.id).eq('next_no', number)
  if (updateError) throw updateError
  return `${prefix}${String(number).padStart(5, '0')}`
}

async function materialize(template: Awaited<ReturnType<typeof getRecurringTemplate>> & object, companyId: string, userId: string): Promise<GeneratedTransaction> {
  const payload = asObject(template.transactionPayload)
  const lines = asLines(payload.lines)
  const client = createAdminClient()
  const now = new Date()
  const date = now.toISOString()
  const currency = template.currency
  const transactionType = template.transactionType as TransactionType
  if (!lines.length && !['PAYMENT', 'TRANSFER', 'DEPOSIT', 'CHEQUE'].includes(transactionType)) throw new Error('Transaction details require at least one line')

  if (transactionType === 'INVOICE' || transactionType === 'CREDIT_NOTE') {
    const { processedLines, subtotal, taxAmount, total } = processSalesLines(lines.map((line) => ({
      description: String(line.description ?? ''), quantity: Number(line.quantity ?? 1), unitPrice: Number(line.unitPrice ?? 0),
      taxRate: Number(line.taxRate ?? 0), accountId: line.accountId ? String(line.accountId) : null,
    })))
    const number = await nextSequence(companyId, transactionType === 'INVOICE' ? 'INVOICE' : 'CREDIT_NOTE', transactionType === 'INVOICE' ? 'INV-' : 'CN-')
    const dueDate = new Date(now); dueDate.setUTCDate(dueDate.getUTCDate() + Number(payload.dueDays ?? 30))
    const { data, error } = await client.from('invoices').insert({ company_id: companyId, invoice_no: number,
      invoice_type: transactionType === 'CREDIT_NOTE' ? 'CREDIT_NOTE' : 'STANDARD', customer_id: template.customerId,
      date, due_date: dueDate.toISOString(), currency, status: 'DRAFT', subtotal, tax_amount: taxAmount, total, balance: total,
      notes: template.notes, terms: payload.terms ?? null, is_recurring: true, created_by_id: userId,
    }).select('id').single()
    if (error) throw error
    const { error: lineError } = await client.from('invoice_lines').insert(processedLines.map((line) => ({ company_id: companyId, invoice_id: data.id,
      description: line.description, quantity: line.quantity, unit_price: line.unitPrice, tax_rate: line.taxRate, amount: line.amount, account_id: line.accountId })))
    if (lineError) throw lineError
    return { id: data.id, number }
  }

  if (transactionType === 'BILL' || transactionType === 'PURCHASE_ORDER') {
    const { subtotal, taxAmount, total, processed } = processPurchaseLines(lines.map((line) => ({ description: String(line.description ?? ''),
      quantity: Number(line.quantity ?? 1), unitPrice: Number(line.unitPrice ?? 0), taxRate: Number(line.taxRate ?? 0), accountId: line.accountId ? String(line.accountId) : undefined })))
    const isBill = transactionType === 'BILL'
    const number = await nextSequence(companyId, isBill ? 'BILL' : 'PURCHASE_ORDER', isBill ? 'BILL-' : 'PO-')
    const due = new Date(now); due.setUTCDate(due.getUTCDate() + Number(payload.dueDays ?? 30))
    const table = isBill ? 'bills' : 'purchase_orders'
    const { data, error } = await client.from(table).insert(isBill ? {
      company_id: companyId, bill_no: number, vendor_id: template.vendorId, date, due_date: due.toISOString(), currency,
      status: 'DRAFT', approval_status: 'PENDING', subtotal, tax_amount: taxAmount, total, balance: total, notes: template.notes,
      reference: template.referenceNumber, is_recurring: true, created_by_id: userId,
    } : { company_id: companyId, po_no: number, vendor_id: template.vendorId, date, expected_date: due.toISOString(), currency,
      status: 'OPEN', subtotal, tax_amount: taxAmount, total, notes: template.notes }).select('id').single()
    if (error) throw error
    const lineTable = isBill ? 'bill_lines' : 'purchase_order_lines'
    const fk = isBill ? 'bill_id' : 'purchase_order_id'
    const { error: lineError } = await client.from(lineTable).insert(processed.map((line) => ({ company_id: companyId, [fk]: data.id, ...line })))
    if (lineError) throw lineError
    return { id: data.id, number }
  }

  if (transactionType === 'EXPENSE') {
    const number = await nextSequence(companyId, 'EXPENSE', 'EXP-')
    const normalized = lines.map((line) => ({ description: String(line.description ?? ''), amount: Number(line.amount ?? line.unitPrice ?? 0), taxRate: Number(line.taxRate ?? 0), accountId: line.accountId ? String(line.accountId) : null }))
    const total = normalized.reduce((sum, line) => sum + line.amount, 0)
    const taxAmount = normalized.reduce((sum, line) => sum + line.amount * line.taxRate / 100, 0)
    const { data, error } = await client.from('expenses').insert({ company_id: companyId, expense_no: number, date,
      description: template.description ?? template.templateName, category: String(payload.category ?? 'Recurring'), status: 'PENDING', total,
      tax_amount: taxAmount, created_by_id: userId }).select('id').single()
    if (error) throw error
    const { error: lineError } = await client.from('expense_lines').insert(normalized.map((line) => ({ company_id: companyId, expense_id: data.id,
      description: line.description, amount: line.amount, tax_rate: line.taxRate, account_id: line.accountId })))
    if (lineError) throw lineError
    return { id: data.id, number }
  }

  if (transactionType === 'ESTIMATE' || transactionType === 'SALES_RECEIPT') {
    const { processedLines, subtotal, taxAmount, total } = processSalesLines(lines.map((line) => ({ description: String(line.description ?? ''),
      quantity: Number(line.quantity ?? 1), unitPrice: Number(line.unitPrice ?? 0), taxRate: Number(line.taxRate ?? 0), accountId: line.accountId ? String(line.accountId) : null })))
    const isEstimate = transactionType === 'ESTIMATE'
    const number = await nextSequence(companyId, transactionType, isEstimate ? 'EST-' : 'SR-')
    const table = isEstimate ? 'estimates' : 'sales_receipts'
    const { data, error } = await client.from(table).insert(isEstimate ? { company_id: companyId, estimate_no: number, customer_id: template.customerId,
      date, expiry_date: null, status: 'DRAFT', currency, subtotal, tax_amount: taxAmount, total, notes: template.notes } : {
      company_id: companyId, receipt_no: number, customer_id: template.customerId, date, currency, subtotal, tax_amount: taxAmount,
      total, payment_method: payload.paymentMethod ?? 'CASH', notes: template.notes }).select('id').single()
    if (error) throw error
    if (isEstimate) {
      const { error: lineError } = await client.from('estimate_lines').insert(processedLines.map((line) => ({ company_id: companyId, estimate_id: data.id,
        description: line.description, quantity: line.quantity, unit_price: line.unitPrice, tax_rate: line.taxRate, amount: line.amount, account_id: line.accountId })))
      if (lineError) throw lineError
    }
    return { id: data.id, number }
  }

  throw new Error(`${transactionType.replaceAll('_', ' ')} automatic generation is not registered yet`)
}

export async function executeRecurringTemplate(companyId: string, userId: string, id: string, triggerType: 'MANUAL' | 'AUTOMATIC' | 'RETRY' = 'MANUAL') {
  const template = await getRecurringTemplate(companyId, id)
  if (!template) return null
  if (template.status !== 'ACTIVE') throw new Error(`Cannot run a ${String(template.status).toLowerCase()} template`)
  if (triggerType !== 'MANUAL' && template.type === 'UNSCHEDULED') throw new Error('Unscheduled templates can only be run manually')
  const client = createAdminClient()
  const { data: execution, error } = await client.from('recurring_transaction_executions').insert({ company_id: companyId,
    template_id: id, schedule_id: template.schedule.id ?? null, status: 'RUNNING', trigger_type: triggerType,
    generated_transaction_type: template.transactionType, executed_by_id: userId, attempt_no: Number(template.schedule.retryCount ?? 0) + 1,
  }).select('id').single()
  if (error) throw error
  const now = new Date()
  try {
    if (template.type === 'REMINDER') {
      await client.from('recurring_transaction_executions').update({ status: 'REMINDER_SENT', completed_at: now.toISOString() }).eq('id', execution.id)
    } else {
      const generated = await materialize(template, companyId, userId)
      await client.from('recurring_transaction_executions').update({ status: 'SUCCESS', generated_transaction_id: generated.id,
        generated_transaction_number: generated.number, completed_at: now.toISOString() }).eq('id', execution.id)
    }
    const next = calculateNextExecutionDate(template.schedule.nextDate ? String(template.schedule.nextDate) : now, template.schedule.frequency as RecurringTemplateInput['schedule']['frequency'], template.schedule.intervalCount, template.schedule.customRule)
    const completed = template.schedule.endDate && next > new Date(String(template.schedule.endDate))
    await client.from('recurring_transaction_schedules').update({ previous_run_date: now.toISOString(), next_run_date: completed ? null : next.toISOString(),
      retry_count: 0, last_error: null, processing_started_at: null }).eq('company_id', companyId).eq('template_id', id)
    if (completed) await client.from('recurring_transaction_templates').update({ status: 'COMPLETED' }).eq('company_id', companyId).eq('id', id)
    await logAudit({ companyId, userId, action: triggerType === 'MANUAL' ? 'MANUAL_EXECUTION' : 'AUTOMATIC_EXECUTION', entityType: 'RECURRING_TRANSACTION', entityId: id, details: { executionId: execution.id } })
  } catch (runError) {
    const message = runError instanceof Error ? runError.message : String(runError)
    await client.from('recurring_transaction_executions').update({ status: 'FAILED', error: message, completed_at: new Date().toISOString() }).eq('id', execution.id)
    await client.from('recurring_transaction_schedules').update({ retry_count: Number(template.schedule.retryCount ?? 0) + 1, last_error: message,
      processing_started_at: null }).eq('company_id', companyId).eq('template_id', id)
    await logAudit({ companyId, userId, action: `${triggerType}_EXECUTION_FAILED`, entityType: 'RECURRING_TRANSACTION', entityId: id, details: { error: message, executionId: execution.id } })
    throw runError
  }
  return getRecurringTemplate(companyId, id)
}

export async function listExecutionHistory(companyId: string, templateId: string) {
  const { data, error } = await createAdminClient().from('recurring_transaction_executions')
    .select('*, executor:profiles(full_name)').eq('company_id', companyId).eq('template_id', templateId).order('execution_date', { ascending: false })
  if (error) throw error
  return (data ?? []).map((row) => ({ id: row.id, executionDate: row.execution_date, status: row.status,
    generatedTransaction: row.generated_transaction_number, generatedTransactionId: row.generated_transaction_id,
    generatedTransactionType: row.generated_transaction_type, executedBy: (row.executor as { full_name?: string } | null)?.full_name ?? 'System', error: row.error }))
}

export async function exportRecurringTemplates(companyId: string, requestUrl: string) {
  const source = new URL(requestUrl)
  const rows: Awaited<ReturnType<typeof listRecurringTemplates>>['items'] = []
  let page = 1
  let total = 0
  do {
    source.searchParams.set('page', String(page))
    source.searchParams.set('limit', '1000')
    const result = await listRecurringTemplates(companyId, source.toString())
    rows.push(...result.items)
    total = result.total
    page += 1
  } while (rows.length < total)

  const headers = ['Template Name', 'Type', 'TXN Type', 'Interval', 'Previous Date', 'Next Date', 'Customer / Supplier', 'Amount', 'Currency', 'Status']
  const lines = rows.map((row) => [row.templateName, row.type, row.transactionType,
    `${row.schedule.frequency}:${row.schedule.intervalCount}`, row.schedule.previousDate, row.schedule.nextDate,
    row.partyName, row.amount, row.currency, row.status])
  return { headers, rows: lines }
}

export async function processDueRecurringTransactions(companyId: string, systemUserId: string, limit = 50) {
  const client = createAdminClient()
  const { data, error } = await client.from('recurring_transaction_schedules').select('template_id, processing_started_at, templates:recurring_transaction_templates!inner(status, recurrence_type)')
    .eq('company_id', companyId).lte('next_run_date', new Date().toISOString()).limit(limit)
  if (error) throw error
  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const row of data ?? []) {
    const template = asObject(row.templates)
    if (template.status !== 'ACTIVE' || template.recurrence_type === 'UNSCHEDULED') continue
    const fullTemplate = await getRecurringTemplate(companyId, row.template_id)
    if (!fullTemplate) continue
    if (fullTemplate.schedule.retryCount >= fullTemplate.schedule.maxRetries && fullTemplate.schedule.lastError) continue
    const staleBefore = Date.now() - 15 * 60_000
    if (row.processing_started_at && new Date(row.processing_started_at).getTime() > staleBefore) continue
    const claimedAt = new Date().toISOString()
    const { data: claimed } = await client.from('recurring_transaction_schedules').update({ processing_started_at: claimedAt })
      .eq('company_id', companyId).eq('template_id', row.template_id).select('template_id').maybeSingle()
    if (!claimed) continue
    const trigger = fullTemplate.schedule.retryCount > 0 ? 'RETRY' : 'AUTOMATIC'
    try { await executeRecurringTemplate(companyId, systemUserId, row.template_id, trigger); results.push({ id: row.template_id, ok: true }) }
    catch (runError) { results.push({ id: row.template_id, ok: false, error: runError instanceof Error ? runError.message : String(runError) }) }
  }
  return results
}
