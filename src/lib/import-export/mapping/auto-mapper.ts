import type { ColumnMapping, FieldDefinition } from '../types'
import { getSynonymsForField } from './synonyms'
import { normalizeHeader } from './normalize-header'

/** Provider-owned migration metadata is transported outside user mappings. */
export const PROTECTED_MIGRATION_FIELDS = new Set([
  '_realmId',
  '_quickbooksId',
  '_quickbooksEntity',
  '_quickbooksRaw',
  '_quickbooksMeta',
  '_quickbooksSyncToken',
  '_quickbooksRelationships',
  '_quickbooksCustomFields',
  '_syncToken',
  '_linkedTransactions',
  '_customFields',
  '_active',
  '_deleted',
  '_hisabAttachment',
  'SyncToken',
  // The QuickBooks source identity (used for legacy_id/sourceId-first duplicate
  // matching, e.g. accounts.module.ts) is not declared in every module's field
  // list (accounts.fields.ts has none), so without this it is silently dropped
  // here before duplicate detection ever sees it, forcing a fallback to mutable
  // fields like accountNo — which QuickBooks can legitimately reuse after an
  // account is deleted, causing two different QuickBooks records to collide
  // onto one native row.
  'sourceId',
])

export function isProtectedMigrationField(key: string): boolean {
  return PROTECTED_MIGRATION_FIELDS.has(key) || key.startsWith('_quickbooks')
}

export function validateMappingConflicts(mapping: ColumnMapping): string | null {
  const targetToSource = new Map<string, string>()
  for (const [source, target] of Object.entries(mapping)) {
    if (!target) continue
    const existing = targetToSource.get(target)
    if (existing && existing !== source) {
      return `Multiple columns map to "${target}": "${existing}" and "${source}"`
    }
    targetToSource.set(target, source)
  }
  return null
}

export function validateRequiredMapping(
  mapping: ColumnMapping,
  fields: FieldDefinition[],
): string | null {
  const mappedTargets = new Set(Object.values(mapping).filter(Boolean))
  const missing = fields
    .filter((field) => field.importable !== false && field.required)
    .filter((field) => !mappedTargets.has(field.key))
  if (missing.length === 0) return null
  return `Required fields not mapped: ${missing.map((field) => field.label).join(', ')}`
}

export function autoMapColumns(
  headers: string[],
  fields: FieldDefinition[],
): ColumnMapping {
  const importableFields = fields.filter((field) => field.importable !== false)
  const normalizedHeaders = headers.map((header) => ({
    original: header,
    normalized: normalizeHeader(header),
  }))

  const mapping: ColumnMapping = {}
  const usedFields = new Set<string>()

  for (const header of headers) {
    mapping[header] = null
  }

  for (const field of importableFields) {
    const synonyms = getSynonymsForField(field.key).map(normalizeHeader)
    const match = normalizedHeaders.find(
      (header) =>
        !usedFields.has(field.key) &&
        (synonyms.includes(header.normalized) ||
          header.normalized === normalizeHeader(field.label)),
    )

    if (match) {
      mapping[match.original] = field.key
      usedFields.add(field.key)
    }
  }

  return mapping
}

export function applyColumnMapping(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
): Array<{ rowNumber: number; source: Record<string, string>; mapped: Record<string, unknown> }> {
  return rows.map((row, index) => {
    const mapped: Record<string, unknown> = {}
    for (const [sourceHeader, targetField] of Object.entries(mapping)) {
      if (!targetField) continue
      const value = row[sourceHeader]
      if (value !== undefined) {
        mapped[targetField] = value
      }
    }
    for (const [key, value] of Object.entries(row)) {
      if (isProtectedMigrationField(key)) mapped[key] = value
    }
    return { rowNumber: index + 1, source: row, mapped }
  })
}

export function mappingSnapshot(mapping: ColumnMapping): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const [source, target] of Object.entries(mapping)) {
    if (target) snapshot[target] = source
  }
  return snapshot
}
