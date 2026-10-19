import 'server-only'
import { aggregateLedgerBalances } from '@/lib/accounting/ledger'
import { ledgerRangeBounds } from '@/lib/accounting/ledger-report-math'
import type { CanonicalAccountType, NormalBalance } from '@/lib/accounting/types'
import { createAdminClient } from '@/lib/supabase/admin'
import { METRICS, contributionToMetric, groupByDepartment, reconcile, round2, type MetricKey, type ReconciliationStatus } from './drilldown-math'

const CHUNK = 1000
const HARD_CAP = 50_000

export interface DepartmentBreakdown {
  metric: { key: MetricKey; label: string }
  period: { from: string | null; to: string | null }
  companyTotal: number
  departmentsTotal: number
  reconciliation: { difference: number; status: ReconciliationStatus }
  rows: Array<{ costCenterId: string | null; code: string | null; name: string; type: string | null; total: number; lines: number }>
}

/** Metric split by department / cost center, reconciled to the company-level report figure. */
export async function buildDepartmentBreakdown(input: {
  companyId: string
  metric: Exclude<MetricKey, 'account'>
  from?: string | null
  to?: string | null
  asOf?: string | null
  scopeCostCenterIds?: string[] | null
}): Promise<DepartmentBreakdown> {
  const metric = METRICS[input.metric]
  const client = createAdminClient()
  const types = metric.types.map((t) => t.type)
  const asOf = metric.kind === 'asof'
  const today = new Date().toISOString().slice(0, 10)
  const fromIso = asOf ? null : input.from ? ledgerRangeBounds(input.from, input.from).fromIso : null
  const upper = asOf ? input.asOf ?? input.to ?? today : input.to
  const toIso = upper ? ledgerRangeBounds(upper, upper).toIso : null

  const balances = await aggregateLedgerBalances({
    companyId: input.companyId,
    from: fromIso ? new Date(fromIso) : undefined,
    to: toIso ? new Date(toIso) : undefined,
    canonicalTypes: types,
  })
  let companyTotal = 0
  for (const b of balances) {
    const rule = metric.types.find((t) => t.type === b.canonicalType)
    if (rule) companyTotal += rule.sign * b.balance
  }
  companyTotal = round2(companyTotal)

  const scope = input.scopeCostCenterIds?.length ? input.scopeCostCenterIds : null
  type Raw = { cost_center_id: string | null; debit: number; credit: number; account: { canonical_type: string; normal_balance: string; sub_type: string | null; deleted_at: string | null } }
  const lines: Array<{ costCenterId: string | null; amount: number }> = []
  for (let from = 0; from < HARD_CAP; from += CHUNK) {
    let q = client
      .from('ledger_entries')
      .select('cost_center_id, debit, credit, account:chart_of_accounts!ledger_entries_account_id_fkey!inner(canonical_type, normal_balance, sub_type, deleted_at)')
      .eq('company_id', input.companyId)
      .in('account.canonical_type', types)
    if (fromIso) q = q.gte('entry_date', fromIso)
    if (toIso) q = q.lte('entry_date', toIso)
    if (scope) q = q.in('cost_center_id', scope)
    const { data, error } = await q.order('id').range(from, from + CHUNK - 1)
    if (error) throw error
    for (const e of (data ?? []) as unknown as Raw[]) {
      // Mirror the report: deleted and header accounts are not part of the aggregate.
      if (e.account.deleted_at || (e.account.sub_type ?? '') === 'Header') continue
      lines.push({
        costCenterId: e.cost_center_id,
        amount: contributionToMetric(metric, {
          debit: Number(e.debit ?? 0),
          credit: Number(e.credit ?? 0),
          canonicalType: e.account.canonical_type as CanonicalAccountType,
          normalBalance: e.account.normal_balance as NormalBalance,
        }),
      })
    }
    if ((data ?? []).length < CHUNK) break
  }

  const groups = groupByDepartment(lines)
  const ids = groups.map((g) => g.costCenterId).filter((i): i is string => Boolean(i))
  const info = new Map<string, { code: string; name: string; type: string }>()
  if (ids.length) {
    const { data } = await client.from('cost_centers').select('id, code, name, type').eq('company_id', input.companyId).in('id', ids)
    for (const c of data ?? []) info.set(String(c.id), { code: String(c.code), name: String(c.name), type: String(c.type) })
  }
  const departmentsTotal = round2(groups.reduce((s, g) => s + g.total, 0))
  return {
    metric: { key: metric.key, label: metric.label },
    period: { from: fromIso, to: toIso },
    companyTotal,
    departmentsTotal,
    // With a scope the buckets only cover the permitted cost centers, so no company-level comparison is made.
    reconciliation: scope ? { difference: 0, status: 'RECONCILED' } : reconcile(companyTotal, departmentsTotal),
    rows: groups.map((g) => {
      const c = g.costCenterId ? info.get(g.costCenterId) : undefined
      return {
        costCenterId: g.costCenterId,
        code: c?.code ?? null,
        name: c ? c.name : g.costCenterId ? 'Unknown cost center' : 'Not assigned',
        type: c?.type ?? null,
        total: g.total,
        lines: g.lines,
      }
    }),
  }
}
