import 'server-only'
import type { ChartOfAccountRecord } from '@/lib/db/entities'
import { getAccountRepository } from '@/lib/db/provider'
import {
  parseBooleanField,
  parseOptionalString,
} from '../../parse-helpers'
import type { DuplicateMatch, MappedRow, ModuleDefinition } from '../../types'
import { ACCOUNT_FIELDS } from './accounts.fields'
import { ACCOUNT_OFFICIAL_TEMPLATES } from './accounts.official-templates'
import {
  deriveAccountNameFromFullName,
  deriveParentAccountNo,
} from '../../templates/row-transforms'

export { ACCOUNT_FIELDS } from './accounts.fields'

function parseAccountImportRow(mapped: Record<string, unknown>) {
  const name = String(mapped.name ?? '').trim()
  return {
    accountNo: String(mapped.accountNo ?? '').trim(),
    name,
    fullName: parseOptionalString(mapped.fullName) ?? name,
    parentNo: parseOptionalString(mapped.parentNo),
    accountType: String(mapped.accountType ?? '').trim(),
    subType: String(mapped.subType ?? '').trim(),
    description: parseOptionalString(mapped.description),
    isActive: parseBooleanField(mapped.isActive, true),
    // Present only for QuickBooks-sourced rows (normalizeRecords sets `sourceId` on every
    // resource). Non-QuickBooks CSV imports have no sourceId and fall back to accountNo matching.
    sourceId: parseOptionalString(mapped.sourceId),
  }
}

export const accountsModule: ModuleDefinition = {
  key: 'accounts',
  displayName: 'Chart of Accounts',
  fields: ACCOUNT_FIELDS,
  officialTemplates: ACCOUNT_OFFICIAL_TEMPLATES,
  duplicateKeys: ['accountNo'],

  transformOfficialRow(mapped, templateId) {
    if (templateId !== 'standard') return mapped
    const accountNo = String(mapped.accountNo ?? '').trim()
    const fullName = String(mapped.fullName ?? '').trim()
    return {
      ...mapped,
      name: deriveAccountNameFromFullName(fullName),
      parentNo: deriveParentAccountNo(accountNo),
      isActive: true,
    }
  },

  parseImportRow: (mapped) => parseAccountImportRow(mapped) as unknown as Record<string, unknown>,

  async findDuplicate(record) {
    const parsed = parseAccountImportRow(record)
    const existing = await getAccountRepository().findDuplicate({ accountNo: parsed.accountNo, sourceId: parsed.sourceId })
    if (!existing) return null
    return { id: existing.id, matchedOn: parsed.sourceId && existing.legacyId === parsed.sourceId ? ['sourceId'] : ['accountNo'] }
  },

  async findDuplicatesBatch(rows: MappedRow[]) {
    const repo = getAccountRepository()
    const inputs = rows.map((row) => {
      const parsed = parseAccountImportRow(row.mapped)
      return { rowNumber: row.rowNumber, accountNo: parsed.accountNo, sourceId: parsed.sourceId }
    })
    const matches = await repo.findDuplicatesBatch(inputs)
    return matches.map((match): DuplicateMatch => ({
      rowNumber: match.rowNumber,
      existingId: match.existingId,
      matchedOn: match.matchedOn,
    }))
  },

  async createRecord(record) {
    const parsed = parseAccountImportRow(record)
    const { sourceId, ...create } = parsed
    const created = await getAccountRepository().create({ ...create, legacyId: sourceId })
    return { id: created.id }
  },

  async updateRecord(id, record) {
    const parsed = parseAccountImportRow(record)
    const { accountNo: _accountNo, sourceId, ...update } = parsed
    // Only touch legacy_id when this row carries a QuickBooks sourceId — never null it out
    // on a plain CSV re-import of an account that was originally linked to QuickBooks.
    await getAccountRepository().update(id, sourceId ? { ...update, legacyId: sourceId } : update)
  },

  async exportRecords(filters) {
    return getAccountRepository().findMany({
      search: filters.search || undefined,
      type: filters.type || undefined,
    })
  },

  mapExportRow(record) {
    const account = record as ChartOfAccountRecord
    return {
      accountNo: account.accountNo,
      name: account.name,
      fullName: account.fullName,
      parentNo: account.parentNo,
      accountType: account.accountType,
      subType: account.subType,
      description: account.description,
      isActive: account.isActive,
    }
  },
}
