import { guarded } from '@/lib/permissions/guard'
import { hasPermission } from '@/lib/permissions/catalog'
import { requirePermission } from '@/lib/permissions/server'
import { authzErrorResponse } from '@/lib/authz'
import { buildDrilldown } from '@/lib/reporting/drilldown'
import { isMetricKey } from '@/lib/reporting/drilldown-math'
import { requireAuth } from '@/lib/auth'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Breakdown behind a report figure. Anyone who may view reports sees the aggregate, explanation and
 * reconciliation; transaction rows additionally require ledger.view (and honour its cost-center scope).
 * The company always comes from the validated session, never from the query string.
 */
async function handleGet(request: Request) {
  try {
    const sp = new URL(request.url).searchParams
    const metric = sp.get('metric')
    if (!isMetricKey(metric)) return Response.json({ error: 'Unknown metric' }, { status: 400 })
    const accountId = sp.get('accountId')
    const costCenterId = sp.get('costCenterId')
    for (const id of [accountId, costCenterId === 'unassigned' ? null : costCenterId]) if (id && !UUID.test(id)) return Response.json({ error: 'Invalid identifier' }, { status: 400 })
    for (const k of ['from', 'to', 'asOf']) {
      const v = sp.get(k)
      if (v && !DATE.test(v)) return Response.json({ error: `${k} must be YYYY-MM-DD` }, { status: 400 })
    }

    const ctx = await requirePermission('reports.view')
    const user = await requireAuth()
    const canSeeRows = hasPermission(ctx.snapshot.access, 'ledger.view')
    const scope = ctx.snapshot.access.permissions.get('ledger.view')?.scope?.costCenterIds ?? null

    const result = await buildDrilldown({
      companyId: ctx.companyId,
      metric,
      accountId,
      costCenterId,
      from: sp.get('from'),
      to: sp.get('to'),
      asOf: sp.get('asOf'),
      currency: user.currency,
      includeRows: canSeeRows,
      scopeCostCenterIds: canSeeRows ? scope : null,
      limit: Number(sp.get('limit') ?? 200),
      offset: Number(sp.get('offset') ?? 0),
    })
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof Error && /not found|required/i.test(error.message)) {
      return Response.json({ error: error.message }, { status: 400 })
    }
    return authzErrorResponse(error)
  }
}

export const GET = guarded('reports.view', handleGet)
