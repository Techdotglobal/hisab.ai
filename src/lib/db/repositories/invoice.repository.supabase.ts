import 'server-only'
import type { InvoiceType } from '@/lib/db/prisma-types'
import { resolveTransactionCurrency } from '@/lib/currency/company'
import { classifySalesInvoiceType, isAdjustableTaxInvoice } from '@/lib/zatca/classification'
import {
  calculateInvoiceTotals,
  type InvoiceTaxCalculationMethod,
} from '@/lib/invoices/calculations'
import { normalizeTaxCalculationMethod } from '@/lib/invoices/validation'
import {
  changedPostedInvoiceFields,
  isPostedInvoiceStatus,
  POSTED_INVOICE_DELETE_ERROR,
  POSTED_INVOICE_EDIT_ERROR,
  postedLineSignature,
} from '@/lib/invoices/posted-guard'
import { randomUUID } from 'crypto'
import {
  mapChartOfAccountRow,
  mapCustomerRow,
  mapInvoiceAttachmentRow,
  mapInvoiceLineRow,
  mapInvoiceRow,
  mapPaymentRow,
} from '../entity-mappers'
import type { InvoiceRecord } from '../entities'
import { isUuid, queryByIdOrLegacy, resolveCompanyId, resolveCompanyIdOrThrow, supabaseDb } from '../repository-utils'
import { allocateDocumentNumber } from '@/lib/document-numbering/service'
import type {
  InvoiceAdjustmentCreateInput,
  InvoiceCreateInput,
  InvoiceLineInput,
  InvoiceListOptions,
  InvoiceRepository,
  InvoiceUpdateInput,
} from './invoice.repository.interface'
import { mapInvoiceSortColumn, resolveInvoiceDateRange } from './invoice-list-utils'

function formatIssueTime(date: Date): string {
  return date.toTimeString().split(' ')[0]
}

export function processLines(
  lines: InvoiceLineInput[],
  method: InvoiceTaxCalculationMethod = 'TAX_EXCLUSIVE',
) {
  const { lines: calculated, subtotal, taxAmount, total } = calculateInvoiceTotals(
    lines.map((line) => ({
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice),
      taxRate: Number(line.taxRate),
    })),
    method,
  )

  const processedLines = lines.map((line, index) => {
    const calc = calculated[index]
    return {
      description: line.description?.trim() || line.itemName?.trim() || 'Item',
      quantity: calc.quantity,
      unitPrice: calc.unitPrice,
      taxRate: calc.taxRate,
      taxRateId: line.taxRateId || null,
      amount: calc.amount,
      accountId: line.accountId || null,
      costCenterId: line.costCenterId || null,
      inventoryItemId: line.inventoryItemId || null,
      itemName: line.itemName?.trim() || null,
      projectId: line.projectId || null,
      classId: line.classId || null,
      locationId: line.locationId || null,
      projectService: line.projectService?.trim() || null,
      className: line.className?.trim() || null,
    }
  })

  return { processedLines, subtotal, taxAmount, total }
}

async function resolveTypedCostCenter(
  id: string | null | undefined,
  expectedType: 'PROJECT' | 'CLASS' | 'LOCATION',
  companyId: string,
): Promise<{ id: string; name: string } | null> {
  if (!id) return null
  const row = await queryByIdOrLegacy(supabaseDb(), 'cost_centers', id, companyId)
  if (!row) return null
  if (String(row.type).toUpperCase() !== expectedType) return null
  if (row.deleted_at) return null
  return { id: String(row.id), name: String(row.name) }
}

async function resolveInvoiceTypeForCustomer(
  customerId: string,
  companyId: string,
): Promise<'STANDARD' | 'SIMPLIFIED'> {
  const db = supabaseDb()
  const { data, error } = await db
    .from('customers')
    .select('tax_id')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return classifySalesInvoiceType({ taxId: data?.tax_id as string | null | undefined })
}

async function resolveStoredNoteInvoiceType(
  invoiceId: string,
  companyId: string,
): Promise<InvoiceType | null> {
  const db = supabaseDb()
  const { data, error } = await db
    .from('invoices')
    .select('invoice_type')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  const type = String(data?.invoice_type ?? '')
  if (type === 'CREDIT_NOTE' || type === 'DEBIT_NOTE') return type
  return null
}

async function resolveScopedUuid(
  table: string,
  id: string | null | undefined,
  companyId: string,
): Promise<string | null> {
  if (!id) return null
  const row = await queryByIdOrLegacy(supabaseDb(), table, id, companyId)
  return row ? String(row.id) : null
}

async function resolveProfileUuid(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  const db = supabaseDb()

  if (isUuid(userId)) {
    const { data, error } = await db.from('profiles').select('id').eq('id', userId).maybeSingle()
    if (error) throw error
    if (data) return String(data.id)
  }

  const { data, error } = await db
    .from('profiles')
    .select('id')
    .eq('legacy_user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data ? String(data.id) : null
}

async function buildLineRows(
  lines: ReturnType<typeof processLines>['processedLines'],
  invoiceId: string,
  companyId: string,
) {
  return Promise.all(
    lines.map(async (line) => {
      const project = await resolveTypedCostCenter(line.projectId, 'PROJECT', companyId)
      const classCenter = await resolveTypedCostCenter(line.classId, 'CLASS', companyId)
      const location = await resolveTypedCostCenter(line.locationId, 'LOCATION', companyId)

      return {
        company_id: companyId,
        invoice_id: invoiceId,
        account_id: await resolveScopedUuid('chart_of_accounts', line.accountId, companyId),
        cost_center_id: await resolveScopedUuid('cost_centers', line.costCenterId, companyId),
        inventory_item_id: await resolveScopedUuid('inventory_items', line.inventoryItemId, companyId),
        tax_rate_id: await resolveScopedUuid('tax_rates', line.taxRateId, companyId),
        project_id: project?.id ?? null,
        class_id: classCenter?.id ?? null,
        ...(location ? { location_id: location.id } : {}),
        description: line.description,
        item_name: line.itemName,
        project_service: project?.name ?? line.projectService,
        class_name: classCenter?.name ?? line.className,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        tax_rate: line.taxRate,
        amount: line.amount,
      }
    }),
  )
}

export const supabaseInvoiceRepository: InvoiceRepository = {
  async findMany(options: InvoiceListOptions = {}) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const search = options.search?.trim().toLowerCase()
    const status = options.status?.trim()
    const zatcaStatus = options.zatcaStatus?.trim()
    const invoiceType = options.invoiceType?.trim()
    const customerId = options.customerId?.trim()
    const page = Math.max(1, options.page ?? 1)
    const limit = Math.min(100, Math.max(1, options.limit ?? 50))
    const sortColumn = mapInvoiceSortColumn(options.sortBy)
    const ascending = options.sortDir === 'asc'
    const { from: dateFrom, to: dateTo } = resolveInvoiceDateRange(options)

    let query = db
      .from('invoices')
      .select('*, customers(name, email)', { count: 'exact' })
      .eq('company_id', companyId)
      .is('deleted_at', null)

    if (status && status !== 'OVERDUE') query = query.eq('status', status)
    if (status === 'OVERDUE') {
      query = query.in('status', ['SENT', 'PARTIAL']).lt('due_date', new Date().toISOString()).gt('balance', 0)
    }
    if (options.overdue) {
      query = query.in('status', ['SENT', 'PARTIAL']).lt('due_date', new Date().toISOString()).gt('balance', 0)
    }
    if (zatcaStatus) query = query.eq('zatca_status', zatcaStatus)
    if (invoiceType) query = query.eq('invoice_type', invoiceType)
    if (customerId) {
      const scopedCustomerId = await resolveScopedUuid('customers', customerId, companyId)
      if (scopedCustomerId) query = query.eq('customer_id', scopedCustomerId)
    }
    if (dateFrom) query = query.gte('date', dateFrom)
    if (dateTo) query = query.lte('date', dateTo)
    if (search) query = query.ilike('invoice_no', `%${search}%`)

    query = query.order(sortColumn, { ascending, nullsFirst: false })
    if (sortColumn !== 'created_at') {
      query = query.order('created_at', { ascending: false })
    }

    const offset = (page - 1) * limit
    const { data, error, count } = await query.range(offset, offset + limit - 1)
    if (error) throw error

    let rows = data ?? []
    if (search) {
      rows = rows.filter((row) => {
        const invNo = String(row.invoice_no).toLowerCase()
        const cust = row.customers as { name?: string } | null
        const custName = cust?.name?.toLowerCase() ?? ''
        return invNo.includes(search) || custName.includes(search)
      })
    }

    if (options.sortBy === 'customerName') {
      rows = [...rows].sort((a, b) => {
        const aName = String((a.customers as { name?: string } | null)?.name ?? '')
        const bName = String((b.customers as { name?: string } | null)?.name ?? '')
        const cmp = aName.localeCompare(bName)
        return ascending ? cmp : -cmp
      })
    }

    const items = rows.map((row) => {
      const invoice = mapInvoiceRow(row)
      const cust = row.customers as { name?: string; email?: string | null } | null
      return {
        ...invoice,
        customer: cust ? { name: cust.name ?? '', email: cust.email ?? null } : undefined,
      }
    })

    return {
      items,
      total: count ?? items.length,
      page,
      limit,
    }
  },

  async findById(id: string) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const row = await queryByIdOrLegacy(db, 'invoices', id, companyId)
    if (!row) return null

    const invoice = mapInvoiceRow(row)

    const [customerRes, linesRes, paymentsRes, profileRes, attachmentsRes] = await Promise.all([
      db.from('customers').select('*').eq('id', invoice.customerId).maybeSingle(),
      db.from('invoice_lines').select('*').eq('invoice_id', invoice.id).eq('company_id', companyId),
      db
        .from('payments')
        .select('*')
        .eq('invoice_id', invoice.id)
        .eq('company_id', companyId)
        .is('deleted_at', null),
      invoice.createdById
        ? db.from('profiles').select('full_name').eq('id', invoice.createdById).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      db
        .from('invoice_attachments')
        .select('*')
        .eq('invoice_id', invoice.id)
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('uploaded_at', { ascending: false }),
    ])

    if (customerRes.error) throw customerRes.error
    if (linesRes.error) throw linesRes.error
    if (paymentsRes.error) throw paymentsRes.error
    if (profileRes.error) throw profileRes.error
    if (attachmentsRes.error) throw attachmentsRes.error

    let referencedInvoiceNo: string | null = null
    let referencedInvoiceType: string | null = null
    if (invoice.referencedInvoiceId) {
      const refRow = await queryByIdOrLegacy(db, 'invoices', invoice.referencedInvoiceId, companyId)
      referencedInvoiceNo = refRow ? String(refRow.invoice_no) : null
      referencedInvoiceType = refRow ? String(refRow.invoice_type) : null
    }

    const accountIds = [...new Set((linesRes.data ?? []).map((l) => l.account_id).filter(Boolean))]
    const accounts = new Map<string, ReturnType<typeof mapChartOfAccountRow>>()

    if (accountIds.length > 0) {
      const { data: acctRows, error: acctError } = await db
        .from('chart_of_accounts')
        .select('*')
        .eq('company_id', companyId)
        .in('id', accountIds as string[])
      if (acctError) throw acctError
      for (const acct of acctRows ?? []) {
        accounts.set(String(acct.id), mapChartOfAccountRow(acct))
      }
    }

    return {
      ...invoice,
      referencedInvoiceNo,
      referencedInvoiceType,
      customer: customerRes.data ? mapCustomerRow(customerRes.data) : undefined,
      lines: (linesRes.data ?? []).map((line) => ({
        ...mapInvoiceLineRow(line),
        account: line.account_id ? accounts.get(String(line.account_id)) ?? null : null,
      })),
      payments: (paymentsRes.data ?? []).map(mapPaymentRow),
      attachments: (attachmentsRes.data ?? []).map(mapInvoiceAttachmentRow),
      createdBy: profileRes.data
        ? { name: (profileRes.data.full_name as string | null) ?? null }
        : undefined,
    } as InvoiceRecord
  },

  async create(input: InvoiceCreateInput) {
    const db = supabaseDb()
    const companyId = await resolveCompanyIdOrThrow(input.companyId)
    const customerId = await resolveScopedUuid('customers', input.customerId, companyId)
    if (!customerId) throw new Error('Customer not found')

    const method = normalizeTaxCalculationMethod(input.taxCalculationMethod)
    const { processedLines, subtotal, taxAmount, total } = processLines(input.lines, method)
    const invoiceNo = input.documentNo ?? await allocateDocumentNumber('INVOICE', companyId)
    const issueDate = new Date(input.date)
    const createdById = await resolveProfileUuid(input.createdById)
    const invoiceType = await resolveInvoiceTypeForCustomer(customerId, companyId)
    const currency = await resolveTransactionCurrency(input.currency)
    const paymentTermId = await resolveScopedUuid('payment_terms', input.paymentTermId, companyId)

    const { data, error } = await db
      .from('invoices')
      .insert({
        company_id: companyId,
        legacy_id: input.legacyId ?? null,
        invoice_no: invoiceNo,
        invoice_uuid: randomUUID(),
        customer_id: customerId,
        invoice_type: invoiceType,
        date: issueDate.toISOString(),
        issue_time: formatIssueTime(issueDate),
        due_date: new Date(input.dueDate).toISOString(),
        expiry_date: input.expiryDate ? new Date(input.expiryDate).toISOString() : null,
        currency,
        tax_calculation_method: method,
        payment_term_id: paymentTermId,
        subtotal,
        tax_amount: taxAmount,
        total,
        balance: total,
        status: input.status ?? 'DRAFT',
        notes: [input.reference ? `QuickBooks reference: ${input.reference}` : null, input.notes ?? null].filter(Boolean).join('\n') || null,
        terms: input.terms ?? null,
        is_recurring: input.isRecurring ?? false,
        recurring_day: input.recurringDay ?? null,
        created_by_id: createdById,
      })
      .select('*')
      .single()

    if (error) throw error

    const invoiceId = String(data.id)
    const lineRows = await buildLineRows(processedLines, invoiceId, companyId)
    if (lineRows.length > 0) {
      const { error: lineError } = await db.from('invoice_lines').insert(lineRows)
      if (lineError) {
        await db.from('invoices').delete().eq('company_id', companyId).eq('id', invoiceId)
        throw lineError
      }
    }

    if (input.companyId) return { ...mapInvoiceRow(data), lines:lineRows.map(mapInvoiceLineRow) } as InvoiceRecord

    const created = await this.findById(invoiceId)
    if (!created) throw new Error('Invoice not found')
    return created
  },

  async createAdjustment(input: InvoiceAdjustmentCreateInput) {
    const db = supabaseDb()
    const companyId = await resolveCompanyIdOrThrow(input.companyId)
    const sourceInvoiceId = await resolveScopedUuid('invoices', input.sourceInvoiceId, companyId)
    if (!sourceInvoiceId) throw new Error('Source invoice not found')

    const source = input.companyId
      ? mapInvoiceRow((await queryByIdOrLegacy(db,'invoices',sourceInvoiceId,companyId))!)
      : await this.findById(sourceInvoiceId)
    if (!source) throw new Error('Source invoice not found')
    if (!isAdjustableTaxInvoice(source.invoiceType)) {
      throw new Error('Credit/debit notes can only be created from a standard or simplified tax invoice')
    }
    if (!input.companyId && !source.customer) throw new Error('Source invoice customer not found')

    const method = normalizeTaxCalculationMethod(source.taxCalculationMethod)
    const { processedLines, subtotal, taxAmount, total } = processLines(input.lines, method)
    if (total <= 0) throw new Error('Adjustment total must be greater than zero')

    const invoiceNo = input.documentNo ?? await allocateDocumentNumber('INVOICE', companyId)
    const issueDate = new Date(input.date)
    const createdById = await resolveProfileUuid(input.createdById)
    const defaultNote = input.adjustmentType === 'CREDIT_NOTE' ? 'Credit note' : 'Debit note'

    const { data, error } = await db
      .from('invoices')
      .insert({
        company_id: companyId,
        legacy_id: input.legacyId ?? null,
        invoice_no: invoiceNo,
        invoice_uuid: randomUUID(),
        customer_id: source.customerId,
        invoice_type: input.adjustmentType,
        referenced_invoice_id: sourceInvoiceId,
        date: issueDate.toISOString(),
        issue_time: formatIssueTime(issueDate),
        due_date: new Date(input.dueDate).toISOString(),
        currency: source.currency,
        tax_calculation_method: method,
        payment_term_id: source.paymentTermId,
        subtotal,
        tax_amount: taxAmount,
        total,
        balance: total,
        status: input.status ?? 'DRAFT',
        notes: input.notes?.trim() || `${defaultNote} for ${source.invoiceNo}`,
        terms: source.terms ?? null,
        created_by_id: createdById,
      })
      .select('*')
      .single()

    if (error) throw error

    const invoiceId = String(data.id)
    const lineRows = await buildLineRows(processedLines, invoiceId, companyId)
    if (lineRows.length > 0) {
      const { error: lineError } = await db.from('invoice_lines').insert(lineRows)
      if (lineError) throw lineError
    }

    if (input.companyId) return { ...mapInvoiceRow(data), lines:lineRows.map(mapInvoiceLineRow) } as InvoiceRecord

    const created = await this.findById(invoiceId)
    if (!created) throw new Error('Invoice not found')
    return created
  },

  async update(id: string, input: InvoiceUpdateInput) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const invoiceId = await resolveScopedUuid('invoices', id, companyId)
    if (!invoiceId) throw new Error('Invoice not found')

    const existingRow = await queryByIdOrLegacy(db, 'invoices', invoiceId, companyId)
    if (!existingRow) throw new Error('Invoice not found')
    const existing = mapInvoiceRow(existingRow)
    if (existing.status === 'PAID') throw new Error('Cannot edit paid invoice')

    const patch: Record<string, unknown> = {}
    if (input.customerId !== undefined) {
      const customerId = await resolveScopedUuid('customers', input.customerId, companyId)
      if (!customerId) throw new Error('Customer not found')
      patch.customer_id = customerId
    }
    if (input.date !== undefined) patch.date = new Date(input.date).toISOString()
    if (input.dueDate !== undefined) patch.due_date = new Date(input.dueDate).toISOString()
    if (input.expiryDate !== undefined) {
      patch.expiry_date = input.expiryDate ? new Date(input.expiryDate).toISOString() : null
    }
    if (input.notes !== undefined) patch.notes = input.notes
    if (input.terms !== undefined) patch.terms = input.terms
    if (input.status !== undefined) patch.status = input.status
    if (input.taxCalculationMethod !== undefined) {
      patch.tax_calculation_method = normalizeTaxCalculationMethod(input.taxCalculationMethod)
    }
    if (input.paymentTermId !== undefined) {
      patch.payment_term_id = await resolveScopedUuid('payment_terms', input.paymentTermId, companyId)
    }
    if (input.currency !== undefined) {
      patch.currency = await resolveTransactionCurrency(input.currency)
    }

    const noteType = await resolveStoredNoteInvoiceType(invoiceId, companyId)
    const customerIdForClassification = input.customerId !== undefined
      ? (patch.customer_id as string)
      : String(existingRow.customer_id)
    if (!noteType && customerIdForClassification) {
      patch.invoice_type = await resolveInvoiceTypeForCustomer(customerIdForClassification, companyId)
    }

    let rewriteLines = input.lines !== undefined
    if (isPostedInvoiceStatus(existing.status)) {
      const method = normalizeTaxCalculationMethod(
        input.taxCalculationMethod ?? existing.taxCalculationMethod,
      )
      const submittedLines = input.lines !== undefined ? processLines(input.lines, method).processedLines : undefined
      const { data: storedLineRows, error: storedLinesError } = await db
        .from('invoice_lines')
        .select('*')
        .eq('company_id', companyId)
        .eq('invoice_id', invoiceId)
      if (storedLinesError) throw storedLinesError
      const changed = changedPostedInvoiceFields(
        {
          customer: String(existingRow.customer_id ?? ''),
          date: new Date(String(existingRow.date)).toISOString(),
          currency: String(existingRow.currency ?? ''),
          taxCalculationMethod: String(existingRow.tax_calculation_method ?? ''),
          status: existing.status,
          lines: postedLineSignature((storedLineRows ?? []).map(mapInvoiceLineRow)),
        },
        {
          customer: patch.customer_id as string | undefined,
          date: patch.date ? new Date(patch.date as string).toISOString() : undefined,
          currency: patch.currency as string | undefined,
          taxCalculationMethod: patch.tax_calculation_method as string | undefined,
          status: patch.status as string | undefined,
          lines: submittedLines ? postedLineSignature(submittedLines) : undefined,
        },
      )
      if (changed.length > 0) throw new Error(POSTED_INVOICE_EDIT_ERROR)
      rewriteLines = false
    }

    if (rewriteLines && input.lines !== undefined) {
      const method = normalizeTaxCalculationMethod(
        input.taxCalculationMethod ?? existing.taxCalculationMethod,
      )
      const { processedLines, subtotal, taxAmount, total } = processLines(input.lines, method)
      patch.subtotal = subtotal
      patch.tax_amount = taxAmount
      patch.total = total
      patch.balance = total - existing.amountPaid
      if (input.taxCalculationMethod === undefined) {
        patch.tax_calculation_method = method
      }

      const { error: deleteLineError } = await db
        .from('invoice_lines')
        .delete()
        .eq('company_id', companyId)
        .eq('invoice_id', invoiceId)
      if (deleteLineError) throw deleteLineError

      const lineRows = await buildLineRows(processedLines, invoiceId, companyId)
      if (lineRows.length > 0) {
        const { error: insertLineError } = await db.from('invoice_lines').insert(lineRows)
        if (insertLineError) throw insertLineError
      }
    }

    const { error } = await db
      .from('invoices')
      .update(patch)
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .is('deleted_at', null)

    if (error) throw error

    const updated = await this.findById(invoiceId)
    if (!updated) throw new Error('Invoice not found')
    return updated
  },

  async delete(id: string) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const invoiceId = await resolveScopedUuid('invoices', id, companyId)
    if (!invoiceId) throw new Error('Invoice not found')

    const existingRow = await queryByIdOrLegacy(db, 'invoices', invoiceId, companyId)
    if (!existingRow) throw new Error('Invoice not found')
    const existing = mapInvoiceRow(existingRow)
    if (existing.status === 'PAID') throw new Error('Cannot delete paid invoice')
    if (isPostedInvoiceStatus(existing.status)) throw new Error(POSTED_INVOICE_DELETE_ERROR)

    const { error } = await db
      .from('invoices')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .eq('company_id', companyId)

    if (error) throw error
  },
}
