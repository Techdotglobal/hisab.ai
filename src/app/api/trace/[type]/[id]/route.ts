import { guarded } from '@/lib/permissions/guard'
import { hasPermission, type PermissionKey } from '@/lib/permissions/catalog'
import { requirePermission } from '@/lib/permissions/server'
import { authzErrorResponse } from '@/lib/authz'
import { buildDocumentTrace, type TraceDocType } from '@/lib/reporting/trace'

const VIEW: Record<TraceDocType, PermissionKey> = { invoice: 'invoices.view', bill: 'bills.view', expense: 'expenses.view' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Accounting trail of one source document: lines and arithmetic, journal entries and GL lines, payments,
 * audit history. Ledger and history sections are only included when the caller may read them.
 */
async function handleGet(_request: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  try {
    const { type, id } = await params
    if (!(type in VIEW) || !UUID.test(id)) return Response.json({ error: 'Not found' }, { status: 404 })
    const docType = type as TraceDocType
    const ctx = await requirePermission(VIEW[docType])
    const trace = await buildDocumentTrace({
      companyId: ctx.companyId,
      type: docType,
      id,
      includeLedger: hasPermission(ctx.snapshot.access, 'ledger.view'),
      includeHistory: hasPermission(ctx.snapshot.access, 'audit_logs.view'),
    })
    if (!trace) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(trace, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export const GET = guarded(['invoices.view', 'bills.view', 'expenses.view'], handleGet)
