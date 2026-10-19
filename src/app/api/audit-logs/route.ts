import { auditEntityHref, auditRowsToCsv, queryAuditLogs } from '@/lib/audit/query'
import { authzErrorResponse } from '@/lib/authz'
import { requirePermission } from '@/lib/permissions/server'
import { logAudit } from '@/lib/audit/log'

export async function GET(request: Request) {
  try {
    const sp = new URL(request.url).searchParams
    const wantsCsv = sp.get('format') === 'csv'
    const ctx = await requirePermission(wantsCsv ? 'audit_logs.export' : 'audit_logs.view')
    const category = sp.get('category')
    const result = await queryAuditLogs({
      companyId: ctx.companyId,
      from: sp.get('from'),
      to: sp.get('to'),
      userId: sp.get('userId'),
      action: sp.get('action'),
      entityType: sp.get('entityType'),
      entityId: sp.get('entityId'),
      category: category === 'permissions' || category === 'financial' ? category : null,
      limit: wantsCsv ? 500 : Number(sp.get('limit') ?? 50),
      offset: Number(sp.get('offset') ?? 0),
    })
    if (wantsCsv) {
      await logAudit({
        companyId: ctx.companyId, userId: ctx.id, action: 'AUDIT_LOG_EXPORTED', entityType: 'audit_log',
        details: { rows: result.rows.length },
      })
      return new Response(auditRowsToCsv(result.rows), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="audit-log.csv"' },
      })
    }
    return Response.json({
      total: result.total,
      rows: result.rows.map((r) => ({ ...r, href: auditEntityHref(r.entityType, r.entityId) })),
    })
  } catch (error) {
    return authzErrorResponse(error)
  }
}
