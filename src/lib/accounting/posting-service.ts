import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import type { LedgerSourceType } from './types'
import {
  validatePostingContext,
  validateNoDuplicatePosting,
  type JournalLineInput,
} from './validation'
import { logPostingAudit } from './posting-audit'
import { resolveFxAmounts } from '@/lib/currency/fx-accounts'

export interface PostJournalOptions {
  companyId?: string
  userId?: string | null
  reason?: string | null
  ipAddress?: string | null
  branchId?: string | null
}

export async function postJournalEntry(
  journalId: string,
  options: PostJournalOptions | string = {},
): Promise<number> {
  const opts: PostJournalOptions = typeof options === 'string'
    ? { companyId: options }
    : options

  const cid = opts.companyId ?? await resolveCompanyId()
  const client = createAdminClient()

  const { data: entry, error: entryError } = await client
    .from('journal_entries')
    .select('*')
    .eq('id', journalId)
    .eq('company_id', cid)
    .single()

  if (entryError || !entry) throw new Error('Journal entry not found')

  const { data: lineRows, error: linesError } = await client
    .from('journal_lines')
    .select('*')
    .eq('journal_id', journalId)
    .eq('company_id', cid)

  if (linesError) throw linesError

  const lines: JournalLineInput[] = (lineRows ?? []).map((l) => ({
    accountId: String(l.account_id),
    debit: Number(l.debit ?? 0),
    credit: Number(l.credit ?? 0),
    costCenterId: (l.cost_center_id as string | null) ?? null,
  }))

  await validateNoDuplicatePosting(cid, journalId)
  await validatePostingContext({
    companyId: cid,
    entryDate: new Date(String(entry.date)),
    lines,
    currency: String(entry.currency ?? 'SAR'),
    branchId: opts.branchId,
  })

  const beforeState = {
    status: entry.status,
    totalDebit: entry.total_debit,
    totalCredit: entry.total_credit,
  }

  const { data: seq, error } = await client.rpc('post_journal_entry', {
    p_journal_id: journalId,
    p_company_id: cid,
  })

  if (error) throw new Error(error.message)

  const postingSequence = Number(seq ?? 0)

  await logPostingAudit({
    action: 'JOURNAL_POSTED',
    entityType: 'journal_entry',
    entityId: journalId,
    userId: opts.userId,
    companyId: cid,
    reason: opts.reason ?? (entry.post_reason as string | null) ?? null,
    ipAddress: opts.ipAddress,
    branchId: opts.branchId,
    beforeState,
    afterState: { status: 'POSTED', postingSequence },
  })

  return postingSequence
}

export interface PostingLine {
  accountId: string
  debit?: number
  credit?: number
  description?: string
  costCenterId?: string | null
  /** When set, uses this rate instead of looking up by date. */
  exchangeRateOverride?: number | null
}

export async function postSourceDocumentToLedger(options: {
  companyId: string
  sourceType: LedgerSourceType
  sourceId: string
  entryDate: Date
  description: string
  currency?: string
  lines: PostingLine[]
  userId?: string | null
  reason?: string | null
  ipAddress?: string | null
}): Promise<void> {
  const client = createAdminClient()
  const currency = options.currency ?? 'SAR'

  const journalLines: JournalLineInput[] = options.lines.map((l) => ({
    accountId: l.accountId,
    debit: l.debit ?? 0,
    credit: l.credit ?? 0,
    costCenterId: l.costCenterId,
  }))

  await validatePostingContext({
    companyId: options.companyId,
    entryDate: options.entryDate,
    lines: journalLines,
    currency,
  })

  const { data: existing } = await client
    .from('ledger_entries')
    .select('id')
    .eq('company_id', options.companyId)
    .eq('source_type', options.sourceType)
    .eq('source_id', options.sourceId)
    .limit(1)

  if (existing && existing.length > 0) {
    return
  }

  const grouped=new Map<string,PostingLine>()
  for(const line of options.lines.filter((item)=>(item.debit??0)>0||(item.credit??0)>0)){
    const direction=(line.debit??0)>0?'debit':'credit',key=`${line.accountId}:${direction}`
    const prior=grouped.get(key)
    if(prior){prior.debit=(prior.debit??0)+(line.debit??0);prior.credit=(prior.credit??0)+(line.credit??0);if(prior.costCenterId!==line.costCenterId)prior.costCenterId=null}
    else grouped.set(key,{...line})
  }

  const rows = []
  for (const line of grouped.values()) {
    const fx = await resolveFxAmounts({
      debit: line.debit,
      credit: line.credit,
      transactionCurrency: currency,
      entryDate: options.entryDate,
      companyId: options.companyId,
      exchangeRateOverride: line.exchangeRateOverride,
    })

    rows.push({
      account_id: line.accountId,
      entry_date: options.entryDate.toISOString(),
      description: line.description ?? options.description,
      debit: fx.transactionDebit,
      credit: fx.transactionCredit,
      currency,
      base_currency: fx.baseCurrency,
      base_debit: fx.baseDebit,
      base_credit: fx.baseCredit,
      exchange_rate: fx.exchangeRate,
      reporting_currency: fx.reportingCurrency,
      reporting_debit: fx.reportingDebit,
      reporting_credit: fx.reportingCredit,
      cost_center_id: line.costCenterId ?? null,
    })
  }

  if (rows.length === 0) return

  const { data: sequence, error: postError } = await client.rpc('post_source_document_lines', {
    p_company_id: options.companyId,
    p_source_type: options.sourceType,
    p_source_id: options.sourceId,
    p_lines: rows,
  })
  if (postError) throw postError
  const seq = Number(sequence ?? 0)

  await logPostingAudit({
    action: 'DOCUMENT_POSTED',
    entityType: options.sourceType,
    entityId: options.sourceId,
    userId: options.userId,
    companyId: options.companyId,
    reason: options.reason,
    ipAddress: options.ipAddress,
    beforeState: null,
    afterState: { postingSequence: seq, lineCount: rows.length },
  })
}

export async function isPeriodClosed(companyId: string, date: Date): Promise<boolean> {
  const client = createAdminClient()
  const { data, error } = await client
    .from('fiscal_periods')
    .select('status')
    .eq('company_id', companyId)
    .lte('period_start', date.toISOString())
    .gte('period_end', date.toISOString())
    .eq('status', 'CLOSED')
    .limit(1)

  if (error) throw error
  return (data?.length ?? 0) > 0
}

export async function findSystemAccount(
  companyId: string,
  matchers: { accountNoPrefix?: string; nameContains?: string; canonicalType?: string },
): Promise<string | null> {
  const client = createAdminClient()
  let query = client
    .from('chart_of_accounts')
    .select('id')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .limit(1)

  if (matchers.accountNoPrefix) {
    query = query.ilike('account_no', `${matchers.accountNoPrefix}%`)
  }
  if (matchers.nameContains) {
    query = query.ilike('name', `%${matchers.nameContains}%`)
  }
  if (matchers.canonicalType) {
    query = query.eq('canonical_type', matchers.canonicalType)
  }

  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return data ? String(data.id) : null
}

/**
 * Resolves a system account against a company's actual chart of accounts by
 * trying several plausible name fragments in priority order.
 *
 * QuickBooks Online's "Automated Sales Tax" (the model every modern QBO
 * company — including migrated ones — uses) does not expose the underlying
 * GL accounts through its API at all; Intuit posts tax internally. There is
 * no immutable QuickBooks identity (unlike accounts/customers/vendors) that
 * can name "the input VAT account" for a migrated company, so which native
 * account plays that role is inherently a destination-side naming
 * convention, not something a source-id lookup can resolve. A single literal
 * name (e.g. exactly "VAT Receivable") is too rigid for real charts of
 * accounts that use a company's own historical naming — this tries a
 * priority-ordered list of the naming conventions actually seen in practice
 * (hisab.ai's own default COA, and common QuickBooks-migrated phrasing).
 */
export async function findSystemAccountByNameCandidates(
  companyId: string,
  candidates: string[],
  matchers: { canonicalType?: string } = {},
): Promise<string | null> {
  for (const nameContains of candidates) {
    const found = await findSystemAccount(companyId, { nameContains, ...matchers })
    if (found) return found
  }
  return null
}
