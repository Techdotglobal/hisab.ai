import { isPostedInvoiceStatus } from './posted-guard'

export type InvoiceEditDecision = { allowed: true } | { allowed: false; reason: string }

/**
 * Who may save changes to an invoice.
 *  - invoices.edit        : full editing (posted-invoice financial-field guard still applies downstream)
 *  - invoices.edit_drafts : may edit only invoices still in DRAFT (e.g. imported, not yet sent/posted),
 *                           and may not move them out of DRAFT — sending/posting needs invoices.edit.
 * Posted, partially paid and paid invoices are never changed through the draft permission; corrections
 * to those go through credit/debit notes.
 */
export function decideInvoiceEdit(input: {
  canEdit: boolean
  canEditDrafts: boolean
  currentStatus: string | null | undefined
  requestedStatus?: string | null
}): InvoiceEditDecision {
  if (input.canEdit) return { allowed: true }
  if (!input.canEditDrafts) return { allowed: false, reason: 'Forbidden' }
  if (input.currentStatus !== 'DRAFT' || isPostedInvoiceStatus(input.currentStatus)) {
    return { allowed: false, reason: 'You can only edit draft invoices.' }
  }
  if (input.requestedStatus && input.requestedStatus !== 'DRAFT') {
    return { allowed: false, reason: 'Sending or posting an invoice requires full invoice edit permission.' }
  }
  return { allowed: true }
}

/** Header fields recorded in the audit trail for an invoice edit (no free text beyond identifiers/amounts). */
export function invoiceAuditSnapshot(inv: {
  status?: unknown; customerId?: unknown; date?: unknown; dueDate?: unknown
  subtotal?: unknown; taxAmount?: unknown; total?: unknown; lines?: unknown[] | null
} | null | undefined): Record<string, unknown> | null {
  if (!inv) return null
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null)
  return {
    status: inv.status ?? null,
    customerId: inv.customerId ?? null,
    date: iso(inv.date),
    dueDate: iso(inv.dueDate),
    subtotal: inv.subtotal === undefined ? null : Number(inv.subtotal),
    taxAmount: inv.taxAmount === undefined ? null : Number(inv.taxAmount),
    total: inv.total === undefined ? null : Number(inv.total),
    lineCount: Array.isArray(inv.lines) ? inv.lines.length : null,
  }
}
