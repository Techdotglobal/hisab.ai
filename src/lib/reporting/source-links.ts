/** Client-safe helpers for linking a ledger line back to the document that produced it. */
export type TraceableSource = 'invoice' | 'bill' | 'expense'

const TRACE_TYPE: Record<string, TraceableSource> = { INVOICE: 'invoice', BILL: 'bill', EXPENSE: 'expense' }

export const SOURCE_HREF: Record<string, (id: string) => string> = {
  INVOICE: (id) => `/invoices/${id}`,
  BILL: (id) => `/bills/${id}`,
  EXPENSE: (id) => `/expenses/${id}`,
}

/** The document type the trace API understands for this ledger source type, or null. */
export function traceTypeFor(sourceType: string | null | undefined): TraceableSource | null {
  return (sourceType && TRACE_TYPE[sourceType]) || null
}

export function sourceHref(sourceType: string | null | undefined, sourceId: string | null | undefined): string | null {
  return sourceType && sourceId && SOURCE_HREF[sourceType] ? SOURCE_HREF[sourceType](sourceId) : null
}
