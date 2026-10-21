import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import type { CanonicalAccountType, LedgerEntryRecord, LedgerSourceType, NormalBalance } from './types'
import { signedBalance } from './normal-balance'
import { ledgerRangeBounds, round4, sumDebitCredit, withRunningBalance } from './ledger-report-math'

function mapLedgerRow(row: Record<string, unknown>): LedgerEntryRecord {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    accountId: String(row.account_id),
    journalEntryId: (row.journal_entry_id as string | null) ?? null,
    journalLineId: (row.journal_line_id as string | null) ?? null,
    sourceType: String(row.source_type) as LedgerSourceType,
    sourceId: (row.source_id as string | null) ?? null,
    entryDate: new Date(String(row.entry_date)),
    description: (row.description as string | null) ?? null,
    debit: Number(row.debit ?? 0),
    credit: Number(row.credit ?? 0),
    currency: String(row.currency ?? 'SAR'),
    costCenterId: (row.cost_center_id as string | null) ?? null,
    postedAt: new Date(String(row.posted_at)),
    createdAt: new Date(String(row.created_at)),
  }
}

export interface LedgerQueryOptions {
  companyId?: string
  accountId?: string
  from?: Date
  to?: Date
  sourceType?: LedgerSourceType
  limit?: number
  offset?: number
}

export async function queryLedgerEntries(options: LedgerQueryOptions = {}): Promise<LedgerEntryRecord[]> {
  const companyId = options.companyId ?? await resolveCompanyId()
  const client = createAdminClient()

  let query = client
    .from('ledger_entries')
    .select('*')
    .eq('company_id', companyId)
    .order('entry_date', { ascending: true })
    .order('posting_sequence', { ascending: true })
    .order('posted_at', { ascending: true })

  if (options.accountId) query = query.eq('account_id', options.accountId)
  if (options.from) query = query.gte('entry_date', options.from.toISOString())
  if (options.to) query = query.lte('entry_date', options.to.toISOString())
  if (options.sourceType) query = query.eq('source_type', options.sourceType)
  if (options.limit) query = query.limit(options.limit)
  if (options.offset) query = query.range(options.offset, options.offset + (options.limit ?? 50) - 1)

  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map(mapLedgerRow)
}

export interface AccountBalanceAgg {
  accountId: string
  accountNo: string
  accountName: string
  canonicalType: CanonicalAccountType
  normalBalance: NormalBalance
  totalDebit: number
  totalCredit: number
  balance: number
}

export async function aggregateLedgerBalances(options: {
  companyId?: string
  asOf?: Date
  from?: Date
  to?: Date
  canonicalTypes?: CanonicalAccountType[]
}): Promise<AccountBalanceAgg[]> {
  const companyId = options.companyId ?? await resolveCompanyId()
  const client = createAdminClient()

  const upperBound = options.asOf ?? options.to
  const { data: accounts, error } = await client.rpc('aggregate_ledger_balances_for_report', {
    p_company_id: companyId,
    p_from: options.from?.toISOString() ?? null,
    p_to: upperBound?.toISOString() ?? null,
  })
  if (error) throw error

  return (accounts ?? []).filter((acc: Record<string,unknown>) => !options.canonicalTypes?.length || options.canonicalTypes.includes(String(acc.canonical_type) as CanonicalAccountType)).map((acc: Record<string,unknown>) => {
    const canonicalType = String(acc.canonical_type ?? 'Asset') as CanonicalAccountType
    const normalBalance = String(acc.normal_balance ?? 'DEBIT') as NormalBalance
    const debit=Number(acc.total_debit??0);const credit=Number(acc.total_credit??0)
    return {
      accountId: String(acc.account_id),
      accountNo: String(acc.account_no),
      accountName: String(acc.account_name),
      canonicalType,
      normalBalance,
      totalDebit: debit,
      totalCredit: credit,
      balance: signedBalance(debit,credit, normalBalance),
    }
  })
}

const AGGREGATE_CHUNK = 1000

export async function getGeneralLedgerReport(options: {
  accountId?: string
  from: Date | string
  to: Date | string
  companyId?: string
  limit?: number
  offset?: number
  /** Restrict to one or more ledger source types ("class of transaction"). */
  sourceTypes?: string[]
  /** Skip opening balance / whole-period totals (cheaper; used by paged export after the first page). */
  skipAggregates?: boolean
}) {
  const companyId = options.companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const { fromIso, toIso } = ledgerRangeBounds(options.from, options.to)
  const sourceTypes = options.sourceTypes?.length ? options.sourceTypes : undefined

  // Every query shares the same account / class scope so balances, totals and rows agree.
  const scoped = (select: string, opts?: { count?: 'exact' }) => {
    let q = client.from('ledger_entries').select(select, opts).eq('company_id', companyId)
    if (options.accountId) q = q.eq('account_id', options.accountId)
    if (sourceTypes) q = q.in('source_type', sourceTypes)
    return q
  }
  const ordered = <T extends { order: (c: string, o: { ascending: boolean }) => T }>(q: T) =>
    q.order('entry_date', { ascending: true }).order('posting_sequence', { ascending: true })

  const pageSize = options.limit ?? 500
  const offset = options.offset ?? 0

  const { data, error, count } = await ordered(
    scoped(`
      *,
      account:chart_of_accounts!ledger_entries_account_id_fkey(account_no, name, account_type, canonical_type, normal_balance),
      cost_center:cost_centers(name,type)
    `, { count: 'exact' }).gte('entry_date', fromIso).lte('entry_date', toIso),
  ).range(offset, offset + pageSize - 1)
  if (error) throw error

  // PostgREST caps responses (1000 rows), so aggregates are accumulated chunk by chunk.
  async function scan(build: () => ReturnType<typeof scoped>, upTo = Infinity) {
    let debit = 0
    let credit = 0
    for (let from = 0; from < upTo; from += AGGREGATE_CHUNK) {
      const take = Math.min(AGGREGATE_CHUNK, upTo - from)
      const { data: rows, error: scanError } = await ordered(build()).range(from, from + take - 1)
      if (scanError) throw scanError
      const list = (rows ?? []) as unknown as { debit: number | string; credit: number | string }[]
      for (const r of list) { debit += Number(r.debit ?? 0); credit += Number(r.credit ?? 0) }
      if (list.length < take) break
    }
    return { debit: round4(debit), credit: round4(credit) }
  }
  const inPeriod = () => scoped('debit, credit').gte('entry_date', fromIso).lte('entry_date', toIso)

  let opening = 0
  let totals = sumDebitCredit([])
  let priorNet = 0
  if (!options.skipAggregates) {
    const before = await scan(() => scoped('debit, credit').lt('entry_date', fromIso))
    opening = round4(before.debit - before.credit)
    totals = await scan(inPeriod)
    if (offset > 0) {
      const prior = await scan(inPeriod, offset)
      priorNet = round4(prior.debit - prior.credit)
    }
  }

  const mapped = ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => {
    const account = row.account as Record<string, unknown> | null
    const costCenter = row.cost_center as Record<string, unknown> | null
    return {
      date: row.entry_date,
      entryNo: row.journal_entry_id,
      description: row.description,
      debit: Number(row.debit ?? 0),
      credit: Number(row.credit ?? 0),
      sourceType: row.source_type,
      sourceId: row.source_id,
      accountId: row.account_id,
      account: account
        ? {
            accountNo: account.account_no,
            name: account.name,
            accountType: account.canonical_type ?? account.account_type,
          }
        : null,
      costCenter: costCenter ? { name: costCenter.name, type: costCenter.type } : null,
    }
  })
  const entries = withRunningBalance(mapped, round4(opening + priorNet))

  return {
    period: { from: fromIso, to: toIso },
    entries,
    openingBalance: opening,
    closingBalance: round4(opening + totals.debit - totals.credit),
    totals: { debit: totals.debit, credit: totals.credit, balance: round4(totals.debit - totals.credit) },
    pagination: { total: count ?? entries.length, limit: pageSize, offset },
  }
}
