import { guarded } from '@/lib/permissions/guard'
import { requirePermission } from '@/lib/permissions/server'
import { authzErrorResponse } from '@/lib/authz'
import { buildDepartmentBreakdown } from '@/lib/reporting/department-breakdown'
import { METRICS } from '@/lib/reporting/drilldown-math'

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A report figure split by department / cost center; the buckets reconcile to the company figure. */
async function handleGet(request: Request) {
  try {
    const sp = new URL(request.url).searchParams
    const metric = sp.get('metric') ?? ''
    if (!(metric in METRICS)) return Response.json({ error: 'Unknown metric' }, { status: 400 })
    for (const k of ['from', 'to', 'asOf']) {
      const v = sp.get(k)
      if (v && !DATE.test(v)) return Response.json({ error: `${k} must be YYYY-MM-DD` }, { status: 400 })
    }
    const ctx = await requirePermission('reports.view', 'cost_centers.view')
    const scope = ctx.snapshot.access.permissions.get('reports.view')?.scope?.costCenterIds ?? null
    const result = await buildDepartmentBreakdown({
      companyId: ctx.companyId,
      metric: metric as keyof typeof METRICS,
      from: sp.get('from'),
      to: sp.get('to'),
      asOf: sp.get('asOf'),
      scopeCostCenterIds: scope,
    })
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return authzErrorResponse(error)
  }
}

export const GET = guarded('reports.view', handleGet)
