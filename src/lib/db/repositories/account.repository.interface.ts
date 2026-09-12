import type { ChartOfAccountRecord } from '../entities'

export interface AccountListOptions {
  search?: string
  type?: string
}

export interface AccountBatchDuplicateInput {
  rowNumber: number
  accountNo?: string | null
  sourceId?: string | null
}

export interface AccountBatchDuplicateMatch {
  rowNumber: number
  existingId: string
  matchedOn: string[]
}

export interface AccountDuplicateCriteria {
  accountNo?: string | null
  sourceId?: string | null
}

export interface AccountCreateInput {
  accountNo: string
  name: string
  fullName?: string
  parentNo?: string | null
  accountType: string
  subType: string
  description?: string | null
  isActive?: boolean
  legacyId?: string | null
}

export interface AccountUpdateInput {
  name?: string
  fullName?: string
  parentNo?: string | null
  accountType?: string
  subType?: string
  description?: string | null
  isActive?: boolean
  legacyId?: string | null
}

export interface AccountRepository {
  findMany(options?: AccountListOptions): Promise<ChartOfAccountRecord[]>
  findById(id: string): Promise<ChartOfAccountRecord | null>
  findDuplicate(criteria: AccountDuplicateCriteria): Promise<ChartOfAccountRecord | null>
  findDuplicatesBatch(inputs: AccountBatchDuplicateInput[]): Promise<AccountBatchDuplicateMatch[]>
  create(input: AccountCreateInput): Promise<ChartOfAccountRecord>
  update(id: string, input: AccountUpdateInput): Promise<ChartOfAccountRecord>
  delete(id: string): Promise<void>
}
