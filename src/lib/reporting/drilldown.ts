import 'server-only'
import { aggregateLedgerBalances } from '@/lib/accounting/ledger'
import { ledgerRangeBounds } from '@/lib/accounting/ledger-report-math'
import type { CanonicalAccountType, NormalBalance } from '@/lib/accounting/types'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  METRICS,
  buildExplanation,
  contributionToMetric,
  describeOrigin,
  reconcile,
  round2,
  type Explanation,
  type MetricDef,
  type MetricKey,
  type ReconciliationStatus,
} from './drilldown-math'

const CHUNK = 1000
const HARD_CAP = 50_000

/** Pseudo cost-center id selecting ledger lines that carry no department/cost center. */
export const UNASSIGNED = 'unassigned'

export interface DrilldownRequest {
  companyId: string
  metric: MetricKey
  accountId?: string | null
  from?: string | null
  to?: string | null
  asOf?: string | null
  costCenterId?: string | null
  currency: string
  /** Rows are only returned when the caller may read ledger detail. */
  includeRows: boolean
  /** If set, the caller may only see these cost centers (scoped ledger.view). */
  scopeCostCenterIds?: string[] | null
  limit?: number
  offset?: number
}

export interface DrilldownRow {
  ledgerEntryId: string
  date: string
  postingDate: string
  reference: string | null
  description: string | null
  sourceType: string
  sourceId: string | null
  origin: string
  sourceStatus: string | null
  counterparty: string | null
  department: string | null
  costCenterType: string | null
  accountNo: string
  accountName: string
  debit: number
  credit: number
  subtotal: number | null
  tax: number | null
  total: number | null
  amountIncluded: number
  journalEntryId: string | null
  journalNo: string | null
  href: string | null
}

export interface DrilldownResult {
  metric: { key: MetricKey; label: string; kind: 'period' | 'asof' }
  period: { from: string | null; to: string | null; asOf: string | null }
  filters: { costCenter: string | null; account: string | null; scopeRestricted: boolean }
  currency: string
  reportTotal: number
  includedTotal: number
  includedCount: number
  excluded: { drafts: number; missingSource: number }
  reconciliation: { difference: number; status: ReconciliationStatus }
  explanation: Explanation
  rows: DrilldownRow[] | null
  detailRestricted: boolean
  pagination: { total: number; limit: number; offset: number }
}

interface RawEntry {
  id: string
  account_id: string
  journal_entry_id: string | null
  source_type: string
  source_id: string | null
  entry_date: string
  posted_at: string
  description: string | null
  debit: number | string
  credit: number | string
  cost_center_id: string | null
  posting_sequence: number | null
  account: { account_no: string; name: string; full_name: string | null; canonical_type: string; normal_balance: string; sub_type: string | null; deleted_at: string | null } | null
}

const SOURCE_HREF: Record<string, (id: string) => string> = {
  INVOICE: (id) => `/invoices/${id}`,
  BILL: (id) => `/bills/${id}`,
  EXPENSE: (id) => `/expenses/${id}`,
}

export function metricDefinition(key: MetricKey, canonicalType?: CanonicalAccountType): MetricDef {
  if (key !== 'account') return METRICS[key]
  return {
    key: 'account',
    label: 'Account balance',
    kind: 'period',
    types: canonicalType ? [{ type: canonicalType, sign: 1 }] : [],
    formula: "Σ (debits − credits) for a debit-normal account, or Σ (credits − debits) for a credit-normal account",
  }
}

export async function buildDrilldown(req: DrilldownRequest): Promise<DrilldownResult> {
  const client = createAdminClient()
  const limit = Math.min(Math.max(req.limit ?? 200, 1), 1000)
  const offset = Math.max(req.offset ?? 0, 0)

  // ---- resolve the metric -------------------------------------------------------------------
  let accountLabel: string | null = null
  let accountType: CanonicalAccountType | undefined
  if (req.metric === 'account') {
    if (!req.accountId) throw new Error('accountId is required for an account drill-down')
    const { data: acct, error } = await client
      .from('chart_of_accounts')
      .select('account_no, name, full_name, canonical_type')
      .eq('company_id', req.companyId)
      .eq('id', req.accountId)
      .maybeSingle()
    if (error) throw error
    if (!acct) throw new Error('Account not found')
    accountLabel = `${acct.account_no} ${acct.full_name ?? acct.name}`
    accountType = acct.canonical_type as CanonicalAccountType
  }
  const metric = metricDefinition(req.metric, accountType)
  const asOfMode = metric.kind === 'asof' || (req.metric === 'account' && !req.from && !req.to && Boolean(req.asOf))

  const bounds = req.from || req.to
    ? ledgerRangeBounds(req.from ?? '1900-01-01', req.to ?? req.asOf ?? '2999-12-31')
    : null
  const asOfIso = req.asOf ? ledgerRangeBounds(req.asOf, req.asOf).toIso : null
  const fromIso = asOfMode ? null : bounds?.fromIso ?? null
  const toIso = asOfMode ? asOfIso ?? bounds?.toIso ?? null : bounds?.toIso ?? null

  // ---- the same aggregate the reports use ----------------------------------------------------
  const types = metric.types.map((t) => t.type)
  const balances = await aggregateLedgerBalances({
    companyId: req.companyId,
    from: fromIso ? new Date(fromIso) : undefined,
    to: toIso ? new Date(toIso) : undefined,
    canonicalTypes: req.metric === 'account' ? undefined : types,
  })
  let reportTotal = 0
  if (req.metric === 'account') {
    reportTotal = balances.find((b) => b.accountId === req.accountId)?.balance ?? 0
  } else {
    for (const b of balances) {
      const rule = metric.types.find((t) => t.type === b.canonicalType)
      if (rule) reportTotal += rule.sign * b.balance
    }
  }
  reportTotal = round2(reportTotal)

  // ---- department / cost-center filter ------------------------------------------------------
  let costCenterLabel: string | null = null
  const unassigned = req.costCenterId === UNASSIGNED
  if (unassigned) costCenterLabel = 'Not assigned to any department / cost center'
  else if (req.costCenterId) {
    const { data: cc } = await client.from('cost_centers').select('code, name').eq('company_id', req.companyId).eq('id', req.costCenterId).maybeSingle()
    if (!cc) throw new Error('Cost center not found')
    costCenterLabel = `${cc.code} ${cc.name}`
  }
  const scope = req.scopeCostCenterIds?.length ? req.scopeCostCenterIds : null

  // ---- scan the ledger lines behind the figure ------------------------------------------------
  const select =
    'id, account_id, journal_entry_id, source_type, source_id, entry_date, posted_at, description, debit, credit, cost_center_id, posting_sequence,' +
    'account:chart_of_accounts!ledger_entries_account_id_fkey!inner(account_no, name, full_name, canonical_type, normal_balance, sub_type, deleted_at)'
  const entries: RawEntry[] = []
  for (let from = 0; from < HARD_CAP; from += CHUNK) {
    let q = client.from('ledger_entries').select(select).eq('company_id', req.companyId)
    if (req.metric === 'account') q = q.eq('account_id', req.accountId!)
    else q = q.in('account.canonical_type', types)
    if (fromIso) q = q.gte('entry_date', fromIso)
    if (toIso) q = q.lte('entry_date', toIso)
    if (unassigned) q = q.is('cost_center_id', null)
    else if (req.costCenterId) q = q.eq('cost_center_id', req.costCenterId)
    if (scope) q = q.in('cost_center_id', scope)
    const { data, error } = await q.order('entry_date', { ascending: true }).order('posting_sequence', { ascending: true }).order('id').range(from, from + CHUNK - 1)
    if (error) throw error
    const batch = ((data ?? []) as unknown as RawEntry[]).filter(
      // Mirror the report: deleted and header accounts are not part of the aggregate.
      (e) => e.account && !e.account.deleted_at && (e.account.sub_type ?? '') !== 'Header',
    )
    entries.push(...batch)
    if ((data ?? []).length < CHUNK) break
  }

  const contributions = entries.map((e) =>
    contributionToMetric(metric, {
      debit: Number(e.debit ?? 0),
      credit: Number(e.credit ?? 0),
      canonicalType: e.account!.canonical_type as CanonicalAccountType,
      normalBalance: e.account!.normal_balance as NormalBalance,
    }),
  )
  const includedTotal = round2(contributions.reduce((s, n) => s + n, 0))
  // When a cost-center filter or scope narrows the lines, the comparable report figure is the
  // filtered one; the unfiltered company report total is reported alongside via `reportTotal`.
  const filtered = Boolean(req.costCenterId || scope)
  const comparable = filtered ? includedTotal : reportTotal
  const recon = filtered
    ? { difference: 0, status: 'RECONCILED' as ReconciliationStatus }
    : reconcile(reportTotal, includedTotal)

  // ---- excluded / unmatched ------------------------------------------------------------------
  const draftCount = async (table: string, extra?: (q: ReturnType<typeof draftBase>) => ReturnType<typeof draftBase>) => {
    let q = draftBase(table)
    if (extra) q = extra(q)
    const { count } = await q
    return count ?? 0
  }
  function draftBase(table: string) {
    let q = client.from(table).select('id', { count: 'exact', head: true }).eq('company_id', req.companyId).eq('status', 'DRAFT').is('deleted_at', null)
    if (fromIso) q = q.gte('date', fromIso)
    if (toIso) q = q.lte('date', toIso)
    return q
  }
  const excludedDrafts = (
    await Promise.all(['journal_entries', 'invoices', 'bills', 'expenses'].map((t) => draftCount(t).catch(() => 0)))
  ).reduce((s, n) => s + n, 0)
  const missingSource = entries.filter((e) => !e.source_id && !e.journal_entry_id).length

  const explanation = buildExplanation({
    metric,
    accountLabel,
    from: req.from ?? null,
    to: req.to ?? null,
    asOf: req.asOf ?? null,
    costCenterLabel,
    currency: req.currency,
    amounts: contributions,
    includedTotal,
    reportTotal: comparable,
    excludedDrafts,
    missingSource,
    recon,
  })

  const base = {
    metric: { key: metric.key, label: req.metric === 'account' ? accountLabel ?? metric.label : metric.label, kind: metric.kind },
    period: { from: fromIso, to: toIso, asOf: asOfIso },
    filters: { costCenter: costCenterLabel, account: accountLabel, scopeRestricted: Boolean(scope) },
    currency: req.currency,
    reportTotal: comparable,
    includedTotal,
    includedCount: entries.length,
    excluded: { drafts: excludedDrafts, missingSource },
    reconciliation: recon,
    explanation,
    pagination: { total: entries.length, limit, offset },
  }
  if (!req.includeRows) return { ...base, rows: null, detailRestricted: true }

  // ---- enrich the requested page with source documents ---------------------------------------
  const page = entries.slice(offset, offset + limit)
  const enrich = await loadSourceInfo(req.companyId, page)
  const rows: DrilldownRow[] = page.map((e, i) => {
    const info = e.source_id ? enrich.sources.get(`${e.source_type}:${e.source_id}`) : undefined
    const journal = e.journal_entry_id ? enrich.journals.get(e.journal_entry_id) : undefined
    const cc = e.cost_center_id ? enrich.costCenters.get(e.cost_center_id) : undefined
    return {
      ledgerEntryId: e.id,
      date: e.entry_date,
      postingDate: e.posted_at,
      reference: info?.ref ?? journal?.entryNo ?? null,
      description: e.description,
      sourceType: e.source_type,
      sourceId: e.source_id,
      origin: describeOrigin({ sourceType: e.source_type, sourceId: e.source_id, journalEntryId: e.journal_entry_id, sourceRef: info?.label ?? null }),
      sourceStatus: info?.status ?? journal?.status ?? null,
      counterparty: info?.counterparty ?? null,
      department: cc ? `${cc.code} ${cc.name}` : null, // null => "Not assigned"
      costCenterType: cc?.type ?? null,
      accountNo: e.account!.account_no,
      accountName: e.account!.full_name ?? e.account!.name,
      debit: Number(e.debit ?? 0),
      credit: Number(e.credit ?? 0),
      subtotal: info?.subtotal ?? null,
      tax: info?.tax ?? null,
      total: info?.total ?? null,
      amountIncluded: contributions[offset + i],
      journalEntryId: e.journal_entry_id,
      journalNo: journal?.entryNo ?? null,
      href: e.source_id && SOURCE_HREF[e.source_type] ? SOURCE_HREF[e.source_type](e.source_id) : null,
    }
  })
  return { ...base, rows, detailRestricted: false }
}

interface SourceInfo {
  ref: string | null
  label: string
  status: string | null
  counterparty: string | null
  subtotal: number | null
  tax: number | null
  total: number | null
}

async function loadSourceInfo(companyId: string, page: RawEntry[]) {
  const client = createAdminClient()
  const idsFor = (type: string) => [...new Set(page.filter((e) => e.source_type === type && e.source_id).map((e) => e.source_id!))]
  const sources = new Map<string, SourceInfo>()
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

  const [invoiceIds, billIds, expenseIds, paymentIds] = [idsFor('INVOICE'), idsFor('BILL'), idsFor('EXPENSE'), idsFor('PAYMENT')]
  const [invoices, bills, expenses, payments] = await Promise.all([
    invoiceIds.length ? client.from('invoices').select('id, invoice_no, status, subtotal, tax_amount, total, customer_id').eq('company_id', companyId).in('id', invoiceIds) : { data: [] },
    billIds.length ? client.from('bills').select('id, bill_no, status, subtotal, tax_amount, total, vendor_id').eq('company_id', companyId).in('id', billIds) : { data: [] },
    expenseIds.length ? client.from('expenses').select('id, expense_no, status, total, tax_amount').eq('company_id', companyId).in('id', expenseIds) : { data: [] },
    paymentIds.length ? client.from('payments').select('id, payment_no, amount, invoice_id, bill_id').eq('company_id', companyId).in('id', paymentIds) : { data: [] },
  ])

  const customerIds = [...new Set((invoices.data ?? []).map((r) => r.customer_id as string).filter(Boolean))]
  const vendorIds = [...new Set((bills.data ?? []).map((r) => r.vendor_id as string).filter(Boolean))]
  const [customers, vendors] = await Promise.all([
    customerIds.length ? client.from('customers').select('id, name').eq('company_id', companyId).in('id', customerIds) : { data: [] },
    vendorIds.length ? client.from('vendors').select('id, name').eq('company_id', companyId).in('id', vendorIds) : { data: [] },
  ])
  const customerName = new Map((customers.data ?? []).map((c) => [String(c.id), String(c.name)]))
  const vendorName = new Map((vendors.data ?? []).map((v) => [String(v.id), String(v.name)]))

  for (const r of invoices.data ?? []) {
    sources.set(`INVOICE:${r.id}`, { ref: String(r.invoice_no), label: `Invoice ${r.invoice_no}`, status: String(r.status), counterparty: customerName.get(String(r.customer_id)) ?? null, subtotal: num(r.subtotal), tax: num(r.tax_amount), total: num(r.total) })
  }
  for (const r of bills.data ?? []) {
    sources.set(`BILL:${r.id}`, { ref: String(r.bill_no), label: `Bill ${r.bill_no}`, status: String(r.status), counterparty: vendorName.get(String(r.vendor_id)) ?? null, subtotal: num(r.subtotal), tax: num(r.tax_amount), total: num(r.total) })
  }
  for (const r of expenses.data ?? []) {
    const total = num(r.total)
    const tax = num(r.tax_amount)
    sources.set(`EXPENSE:${r.id}`, { ref: String(r.expense_no), label: `Expense ${r.expense_no}`, status: String(r.status), counterparty: null, subtotal: total !== null && tax !== null ? round2(total - tax) : null, tax, total })
  }
  for (const r of payments.data ?? []) {
    sources.set(`PAYMENT:${r.id}`, { ref: String(r.payment_no), label: `Payment ${r.payment_no}`, status: null, counterparty: null, subtotal: null, tax: null, total: num(r.amount) })
  }

  const journalIds = [...new Set(page.map((e) => e.journal_entry_id).filter((i): i is string => Boolean(i)))]
  const journals = new Map<string, { entryNo: string; status: string }>()
  if (journalIds.length) {
    const { data } = await client.from('journal_entries').select('id, entry_no, status').eq('company_id', companyId).in('id', journalIds)
    for (const j of data ?? []) journals.set(String(j.id), { entryNo: String(j.entry_no), status: String(j.status) })
  }

  const ccIds = [...new Set(page.map((e) => e.cost_center_id).filter((i): i is string => Boolean(i)))]
  const costCenters = new Map<string, { code: string; name: string; type: string }>()
  if (ccIds.length) {
    const { data } = await client.from('cost_centers').select('id, code, name, type').eq('company_id', companyId).in('id', ccIds)
    for (const c of data ?? []) costCenters.set(String(c.id), { code: String(c.code), name: String(c.name), type: String(c.type) })
  }
  return { sources, journals, costCenters }
}
