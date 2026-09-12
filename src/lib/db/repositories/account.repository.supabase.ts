import 'server-only'
import { resolveAccountClassification } from '@/lib/accounting/account-type-map'
import { mapChartOfAccountRow } from '../entity-mappers'
import type { ChartOfAccountRecord } from '../entities'
import { queryByIdOrLegacy, resolveCompanyId, supabaseDb } from '../repository-utils'
import type {
  AccountBatchDuplicateInput,
  AccountBatchDuplicateMatch,
  AccountCreateInput,
  AccountDuplicateCriteria,
  AccountListOptions,
  AccountRepository,
  AccountUpdateInput,
} from './account.repository.interface'

async function resolveAccountUuid(id: string, companyId: string): Promise<string | null> {
  const row = await queryByIdOrLegacy(supabaseDb(), 'chart_of_accounts', id, companyId)
  return row ? String(row.id) : null
}

export const supabaseAccountRepository: AccountRepository = {
  async findMany(options: AccountListOptions = {}) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const search = options.search?.trim()
    const type = options.type?.trim()

    let query = db
      .from('chart_of_accounts')
      .select('*')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .order('account_no', { ascending: true })

    if (type) query = query.eq('account_type', type)
    if (search) {
      query = query.or(
        `name.ilike.%${search}%,account_no.ilike.%${search}%,full_name.ilike.%${search}%`,
      )
    }

    const { data, error } = await query
    if (error) throw error
    return (data ?? []).map(mapChartOfAccountRow)
  },

  async findById(id: string) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const row = await queryByIdOrLegacy(db, 'chart_of_accounts', id, companyId)
    return row ? mapChartOfAccountRow(row) : null
  },

  async findDuplicate(criteria: AccountDuplicateCriteria) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const sourceId = criteria.sourceId?.trim()
    const accountNo = criteria.accountNo?.trim()

    if (sourceId) {
      const { data, error } = await db
        .from('chart_of_accounts')
        .select('*')
        .eq('company_id', companyId)
        .eq('legacy_id', sourceId)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle()
      if (error) throw error
      // QuickBooks-sourced rows never fall back to accountNo matching: a reused/collided
      // account number must not merge a new QBO identity into an unrelated existing row.
      return data ? mapChartOfAccountRow(data) : null
    }

    if (!accountNo) return null

    const { data, error } = await db
      .from('chart_of_accounts')
      .select('*')
      .eq('company_id', companyId)
      .eq('account_no', accountNo)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()

    if (error) throw error
    return data ? mapChartOfAccountRow(data) : null
  },

  async findDuplicatesBatch(inputs: AccountBatchDuplicateInput[]) {
    if (inputs.length === 0) return []

    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const sourceIds = [...new Set(inputs.map((item) => item.sourceId?.trim()).filter(Boolean) as string[])]
    const accountNos = [...new Set(inputs.map((item) => item.accountNo?.trim()).filter(Boolean) as string[])]

    const byLegacyId = new Map<string, ChartOfAccountRecord>()
    if (sourceIds.length > 0) {
      const { data, error } = await db
        .from('chart_of_accounts')
        .select('*')
        .eq('company_id', companyId)
        .in('legacy_id', sourceIds)
        .is('deleted_at', null)
      if (error) throw error
      for (const row of data ?? []) {
        const account = mapChartOfAccountRow(row)
        if (account.legacyId) byLegacyId.set(account.legacyId, account)
      }
    }

    const byAccountNo = new Map<string, ChartOfAccountRecord>()
    if (accountNos.length > 0) {
      const { data, error } = await db
        .from('chart_of_accounts')
        .select('*')
        .eq('company_id', companyId)
        .in('account_no', accountNos)
        .is('deleted_at', null)
      if (error) throw error
      for (const row of data ?? []) {
        const account = mapChartOfAccountRow(row)
        byAccountNo.set(account.accountNo, account)
      }
    }

    const matches: AccountBatchDuplicateMatch[] = []
    for (const input of inputs) {
      const sourceId = input.sourceId?.trim()
      const accountNo = input.accountNo?.trim()
      if (sourceId && byLegacyId.has(sourceId)) {
        matches.push({
          rowNumber: input.rowNumber,
          existingId: byLegacyId.get(sourceId)!.id,
          matchedOn: ['sourceId'],
        })
        continue
      }
      // QuickBooks-sourced rows (sourceId present) never fall back to accountNo matching:
      // a reused/collided account number must not merge a new QBO identity into an
      // unrelated existing row. accountNo fallback is reserved for non-QuickBooks (CSV) imports.
      if (!sourceId && accountNo && byAccountNo.has(accountNo)) {
        matches.push({
          rowNumber: input.rowNumber,
          existingId: byAccountNo.get(accountNo)!.id,
          matchedOn: ['accountNo'],
        })
      }
    }

    return matches
  },

  async create(input: AccountCreateInput) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const { canonicalType, normalBalance } = resolveAccountClassification(input.accountType)

    const { data, error } = await db
      .from('chart_of_accounts')
      .insert({
        company_id: companyId,
        account_no: input.accountNo,
        name: input.name,
        full_name: input.fullName ?? input.name,
        parent_no: input.parentNo ?? null,
        account_type: input.accountType,
        sub_type: input.subType,
        canonical_type: canonicalType,
        normal_balance: normalBalance,
        description: input.description ?? null,
        is_active: input.isActive ?? true,
        legacy_id: input.legacyId ?? null,
      })
      .select('*')
      .single()

    if (error) throw error
    return mapChartOfAccountRow(data)
  },

  async update(id: string, input: AccountUpdateInput) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const accountId = await resolveAccountUuid(id, companyId)
    if (!accountId) throw new Error('Account not found')

    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.fullName !== undefined) patch.full_name = input.fullName
    if (input.parentNo !== undefined) patch.parent_no = input.parentNo
    if (input.accountType !== undefined) {
      patch.account_type = input.accountType
      const { canonicalType, normalBalance } = resolveAccountClassification(input.accountType)
      patch.canonical_type = canonicalType
      patch.normal_balance = normalBalance
    }
    if (input.subType !== undefined) patch.sub_type = input.subType
    if (input.description !== undefined) patch.description = input.description
    if (input.isActive !== undefined) patch.is_active = input.isActive
    if (input.legacyId !== undefined) patch.legacy_id = input.legacyId

    const { data, error } = await db
      .from('chart_of_accounts')
      .update(patch)
      .eq('id', accountId)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .select('*')
      .single()

    if (error) throw error
    return mapChartOfAccountRow(data)
  },

  async delete(id: string) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const accountId = await resolveAccountUuid(id, companyId)
    if (!accountId) throw new Error('Account not found')

    const { error } = await db
      .from('chart_of_accounts')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', accountId)
      .eq('company_id', companyId)

    if (error) throw error
  },
}
