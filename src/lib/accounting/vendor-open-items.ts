import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * A vendor-visible AP open item originating from a Journal Entry's or a Purchase (expense)'s Accounts-Payable line.
 * The source document (journal_entries or expenses row) is and remains the SOLE general-ledger posting — this table is
 * a pure subledger index, never itself posted to `ledger_entries`. See migration 075_vendor_open_items.sql.
 */
export interface VendorOpenItemInput {
  companyId: string
  vendorId: string
  /** 'PAYABLE': the source credited AP for this vendor (an open liability, like an unpaid bill).
   *  'CREDIT': the source debited AP for this vendor (a reduction, like a vendor credit). */
  direction: 'PAYABLE' | 'CREDIT'
  sourceType: 'JOURNAL_ENTRY' | 'EXPENSE'
  sourceId: string
  sourceLineId?: string | null
  /** The immutable QuickBooks source id this item was derived from — the idempotency key (never regenerated). */
  sourceReference: string
  date: Date
  currency: string
  exchangeRate?: number | null
  total: number
  description?: string | null
}

export interface VendorOpenItem {
  id: string
  companyId: string
  vendorId: string
  direction: 'PAYABLE' | 'CREDIT'
  sourceType: 'JOURNAL_ENTRY' | 'EXPENSE'
  sourceReference: string
  total: number
  appliedAmount: number
  balance: number
}

/**
 * Idempotent create-or-verify: re-materializing the same source produces no change. A source whose amount changed
 * after the item was created fails loudly — the same "resolve the synchronization conflict" pattern already used by
 * materializeBillPayment and postIdempotentTransferJournal — rather than silently drifting or duplicating.
 */
export async function createOrUpdateVendorOpenItem(input: VendorOpenItemInput): Promise<VendorOpenItem> {
  if (!(input.total > 0)) throw new Error(`Vendor open item ${input.sourceReference} must have a positive total.`)
  const db = createAdminClient()
  const existing = await db.from('vendor_open_items').select('*')
    .eq('company_id', input.companyId).eq('source_system', 'QUICKBOOKS').eq('source_type', input.sourceType)
    .eq('source_reference', input.sourceReference).is('deleted_at', null).maybeSingle()
  if (existing.error) throw existing.error

  if (existing.data) {
    const priorAllocated = Number(existing.data.applied_amount ?? 0)
    if (priorAllocated > 0 && Math.abs(Number(existing.data.total) - input.total) > 0.0001) {
      throw new Error(`Vendor open item ${input.sourceReference} changed after payments were already allocated against it; resolve the synchronization conflict.`)
    }
    const updated = await db.from('vendor_open_items').update({
      vendor_id: input.vendorId, direction: input.direction, source_id: input.sourceId, source_line_id: input.sourceLineId ?? null,
      date: input.date.toISOString(), currency: input.currency.toUpperCase(), exchange_rate: input.exchangeRate ?? null,
      total: input.total, balance: Math.max(input.total - priorAllocated, 0), description: input.description ?? null,
    }).eq('id', existing.data.id).select('*').single()
    if (updated.error) throw updated.error
    return mapRow(updated.data)
  }

  const created = await db.from('vendor_open_items').insert({
    company_id: input.companyId, vendor_id: input.vendorId, direction: input.direction,
    source_type: input.sourceType, source_id: input.sourceId, source_line_id: input.sourceLineId ?? null,
    source_system: 'QUICKBOOKS', source_reference: input.sourceReference,
    date: input.date.toISOString(), currency: input.currency.toUpperCase(), exchange_rate: input.exchangeRate ?? null,
    total: input.total, applied_amount: 0, balance: input.total, description: input.description ?? null,
  }).select('*').single()
  if (created.error) throw created.error
  return mapRow(created.data)
}

/** Resolves an existing vendor open item by its QuickBooks source id — used when a vendor payment allocates against it. */
export async function resolveVendorOpenItem(companyId: string, sourceType: 'JOURNAL_ENTRY' | 'EXPENSE', sourceReference: string): Promise<VendorOpenItem | null> {
  const db = createAdminClient()
  const result = await db.from('vendor_open_items').select('*')
    .eq('company_id', companyId).eq('source_system', 'QUICKBOOKS').eq('source_type', sourceType)
    .eq('source_reference', sourceReference).is('deleted_at', null).maybeSingle()
  if (result.error) throw result.error
  return result.data ? mapRow(result.data) : null
}

/**
 * Resolves the vendor open item(s) an entire QuickBooks source document (a JournalEntry's `Id`, not a specific line)
 * produced for a vendor — used when a vendor Payment's `LinkedTxn` names that document as the settlement target or as
 * a credit source (`source_reference` is `"<documentId>:<lineId>"`, so this matches on the document-id prefix). Fails
 * closed rather than guessing when a document produced more than one open item for the same vendor.
 */
export async function resolveVendorOpenItemByDocument(companyId: string, vendorId: string, sourceType: 'JOURNAL_ENTRY' | 'EXPENSE', quickBooksDocumentId: string): Promise<VendorOpenItem> {
  const db = createAdminClient()
  const result = await db.from('vendor_open_items').select('*')
    .eq('company_id', companyId).eq('vendor_id', vendorId).eq('source_system', 'QUICKBOOKS').eq('source_type', sourceType)
    .like('source_reference', `${quickBooksDocumentId}:%`).is('deleted_at', null)
  if (result.error) throw result.error
  const rows = result.data ?? []
  if (rows.length === 0) throw new Error(`No vendor open item was materialized for QuickBooks ${sourceType} ${quickBooksDocumentId}; it must be migrated before this payment.`)
  if (rows.length > 1) throw new Error(`QuickBooks ${sourceType} ${quickBooksDocumentId} produced more than one AP line for this vendor; the payment allocation target is ambiguous.`)
  return mapRow(rows[0])
}

/** Open (balance > 0) items for a vendor — the read AP aging and the vendor statement need. */
export async function listOpenVendorItems(companyId: string, vendorId: string): Promise<VendorOpenItem[]> {
  const db = createAdminClient()
  const result = await db.from('vendor_open_items').select('*')
    .eq('company_id', companyId).eq('vendor_id', vendorId).is('deleted_at', null).gt('balance', 0)
  if (result.error) throw result.error
  return (result.data ?? []).map(mapRow)
}

/**
 * ALL (not just open) items for one vendor in a date range, with the source date attached — the vendor statement's
 * chronological activity list needs the whole history, not just the current open balance (mirrors how it already
 * lists every bill regardless of balance).
 */
export async function listVendorItemsForStatement(companyId: string, vendorId: string, dateFrom?: Date, dateTo?: Date): Promise<Array<VendorOpenItem & { date: Date; description: string | null }>> {
  const db = createAdminClient()
  let query = db.from('vendor_open_items').select('*').eq('company_id', companyId).eq('vendor_id', vendorId).is('deleted_at', null)
  if (dateFrom) query = query.gte('date', dateFrom.toISOString())
  if (dateTo) query = query.lte('date', dateTo.toISOString())
  const result = await query.order('date', { ascending: true })
  if (result.error) throw result.error
  return (result.data ?? []).map((row: Record<string, unknown>) => ({ ...mapRow(row), date: new Date(String(row.date)), description: row.description === undefined || row.description === null ? null : String(row.description) }))
}

export interface VendorOpenItemWithVendor extends VendorOpenItem {
  vendorName: string
  date: Date
  description: string | null
}

/**
 * Every open (balance > 0) vendor_open_items row across all vendors, as of a date — the JE/expense-originating AP
 * items AP aging and the vendor statement must include (items 2/3's explicit requirement) alongside bills and
 * vendor credits. Never touches ledger_entries; this only reads the subledger index.
 */
export async function listAllOpenVendorItems(companyId: string, asOf?: Date): Promise<VendorOpenItemWithVendor[]> {
  const db = createAdminClient()
  let query = db.from('vendor_open_items').select('*,vendor:vendors(id,name)').eq('company_id', companyId).is('deleted_at', null).gt('balance', 0)
  if (asOf) query = query.lte('date', asOf.toISOString())
  const result = await query
  if (result.error) throw result.error
  return (result.data ?? []).map((row: Record<string, unknown>) => ({
    ...mapRow(row),
    vendorName: String((row.vendor as Record<string, unknown> | null)?.name ?? ''),
    date: new Date(String(row.date)),
    description: row.description === undefined || row.description === null ? null : String(row.description),
  }))
}

function mapRow(row: Record<string, unknown>): VendorOpenItem {
  return {
    id: String(row.id), companyId: String(row.company_id), vendorId: String(row.vendor_id),
    direction: row.direction as 'PAYABLE' | 'CREDIT', sourceType: row.source_type as 'JOURNAL_ENTRY' | 'EXPENSE',
    sourceReference: String(row.source_reference), total: Number(row.total),
    appliedAmount: Number(row.applied_amount), balance: Number(row.balance),
  }
}
