import 'server-only'
import { duplicateMatchesToMap } from '../duplicate/duplicate-detector'
import { applyDuplicateStrategy } from '../duplicate/duplicate-detector'
import type {
  DuplicateMatch,
  DuplicateStrategy,
  ImportContext,
  ImportProcessorResult,
  ImportRowError,
  SkippedRecordDiagnostic,
  MappedRow,
  ModuleDefinition,
  ValidationResult,
} from '../types'
import {
  archiveQuickBooksRecord,
  archiveQuickBooksRecordsBatch,
  assertQuickBooksRecordLinked,
  isQuickBooksRecordUnchanged,
  isQuickBooksRecordUnchangedInState,
  loadQuickBooksMigrationPageState,
  materializeQuickBooksCustomFields,
  parseQuickBooksRaw,
  quickBooksSourceIdOf,
  verifyQuickBooksRecordLinked,
} from '../quickbooks/migration-store'
import { assertQuickBooksDependencies } from '../quickbooks/dependency-check'
import { assertQuickBooksAccountingCompleted, getQuickBooksMaterializationStatus, materializeQuickBooksAccounting, tracksQuickBooksMaterialization } from '../quickbooks/accounting-materializer'
import { normalizeImportError } from './import-error'
import type { MigrationTrace } from '../quickbooks/migration-telemetry'

const DEFAULT_BATCH_SIZE = 100
const LOCAL_TABLE_BY_MODULE: Record<string,string> = {
  accounts:'chart_of_accounts', customers:'customers', vendors:'vendors', inventory:'inventory_items', 'cost-centers':'cost_centers', employees:'employees', 'tax-rates':'tax_rates', 'payment-terms':'payment_terms',
  invoices:'invoices', bills:'bills', expenses:'expenses', 'journal-entries':'journal_entries', 'sales-receipts':'sales_receipts', 'purchase-orders':'purchase_orders', 'vendor-credits':'vendor_credits', estimates:'estimates', 'customer-payments':'payments', 'vendor-payments':'payments',
}

/**
 * Master-data QuickBooks modules whose materialization is "create native row +
 * link" with no ledger/accounting side-effects (no `CONFIG` entry in the
 * accounting materializer). Only these take the page-batched tracking-write path
 * in {@link processQuickBooksMasterPage}; every other module (ledger, extended
 * `qb-*`, CSV) keeps the per-record loop unchanged.
 */
const QUICKBOOKS_BATCH_MASTER_MODULES = new Set(['accounts', 'customers', 'vendors', 'employees'])

export interface ProcessImportInput {
  module: ModuleDefinition
  rows: MappedRow[]
  validation: ValidationResult
  duplicateStrategy: DuplicateStrategy
  duplicateMatches?: DuplicateMatch[]
  ctx: ImportContext
  onProgress?: (processed: number, total: number, counts?: Pick<ImportProcessorResult, 'importedCount' | 'updatedCount' | 'skippedCount' | 'failedCount'>) => Promise<void>
  isCancelled?: () => Promise<boolean>
  isPaused?: () => Promise<boolean>
  /** Throws when the worker no longer owns the queue lease. */
  assertActive?: () => Promise<void>
  startAt?: number
  batchSize?: number
  /** Bounds a worker invocation to a single import batch. */
  maxBatches?: number
  trace?: MigrationTrace
}

/**
 * Orders `accounts` rows so a parent account always precedes its children
 * (QuickBooks `parentNo` -> `accountNo`). Every other module is returned
 * unchanged. Exported so the snapshot reader can apply the SAME global
 * ordering across a whole Storage page file BEFORE it is sliced into
 * 100-record import windows — otherwise a child could land in an earlier
 * window than its parent. Pure and idempotent on an already-valid ordering.
 */
export function dependencyOrderedRows(moduleKey:string,rows:MappedRow[]):MappedRow[]{
  if(moduleKey!=='accounts')return rows
  const pending=[...rows],ordered:MappedRow[]=[],available=new Set<string>()
  while(pending.length){
    const index=pending.findIndex(row=>{const parent=String(row.mapped.parentNo??'').trim();return !parent||available.has(parent)})
    const [next]=pending.splice(index>=0?index:0,1)
    ordered.push(next)
    const accountNo=String(next.mapped.accountNo??'').trim();if(accountNo)available.add(accountNo)
  }
  return ordered
}

function skipDiagnostic(row: MappedRow, reason: SkippedRecordDiagnostic['reason'], duplicate?: DuplicateMatch): SkippedRecordDiagnostic {
  const mapped = row.mapped as Record<string, unknown>
  const sourceId = [mapped._quickbooksId, mapped.Id, mapped.id, mapped.docNumber, mapped.accountNo, mapped.sku].find((value) => value !== undefined && value !== null && String(value).trim() !== '')
  const recordName = [mapped.name, mapped.displayName, mapped.customerName, mapped.vendorName, mapped.docNumber].find((value) => value !== undefined && value !== null && String(value).trim() !== '')
  return { rowNumber: row.rowNumber, sourceId: sourceId === undefined ? undefined : String(sourceId), recordName: recordName === undefined ? undefined : String(recordName), reason, duplicateKey: duplicate?.matchedOn?.join(', '), existingRecordId: duplicate?.existingId }
}

/**
 * A page of the QuickBooks migration where every valid row carries provider
 * metadata and the module is a batchable master (see
 * {@link QUICKBOOKS_BATCH_MASTER_MODULES}).
 */
function isQuickBooksMasterMigrationPage(input: ProcessImportInput): boolean {
  if (!QUICKBOOKS_BATCH_MASTER_MODULES.has(input.module.key)) return false
  const validRows = input.rows.filter((row) => input.validation.validRowNumbers.includes(row.rowNumber))
  if (validRows.length === 0) return false
  return validRows.every((row) => {
    const mapped = row.mapped as Record<string, unknown>
    return typeof mapped._realmId === 'string' && mapped._realmId.length > 0
      && typeof mapped._quickbooksEntity === 'string' && mapped._quickbooksEntity.length > 0
      && mapped._quickbooksRaw !== undefined && mapped._quickbooksRaw !== null
  })
}

export async function processImport(
  input: ProcessImportInput,
): Promise<ImportProcessorResult> {
  if (isQuickBooksMasterMigrationPage(input)) {
    return processQuickBooksMasterPage(input)
  }
  const parser = input.module.parseImportRow ?? ((mapped) => mapped)
  const measure = <T>(name: string, operation: () => Promise<T> | T) => input.trace?.measureOperation(name, operation) ?? Promise.resolve(operation())
  const allValidRows = input.rows.filter((row) => input.validation.validRowNumbers.includes(row.rowNumber))
  const validRows = dependencyOrderedRows(input.module.key,allValidRows).slice(input.startAt ?? 0)
  const errors: ImportRowError[] = []
  let importedCount = 0
  let updatedCount = 0
  let skippedCount = 0
  let failedCount = 0
  let paused = false
  const skippedRecords: SkippedRecordDiagnostic[] = []

  const diagnostic = (row: MappedRow, reason: SkippedRecordDiagnostic['reason'], duplicate?: DuplicateMatch): SkippedRecordDiagnostic => {
    const mapped = row.mapped as Record<string, unknown>
    const sourceId = [mapped._quickbooksId, mapped.Id, mapped.id, mapped.docNumber, mapped.accountNo, mapped.sku].find((value) => value !== undefined && value !== null && String(value).trim() !== '')
    const recordName = [mapped.name, mapped.displayName, mapped.customerName, mapped.vendorName, mapped.docNumber].find((value) => value !== undefined && value !== null && String(value).trim() !== '')
    return { rowNumber: row.rowNumber, sourceId: sourceId === undefined ? undefined : String(sourceId), recordName: recordName === undefined ? undefined : String(recordName), reason, duplicateKey: duplicate?.matchedOn?.join(', '), existingRecordId: duplicate?.existingId }
  }

  const duplicateMatches = input.duplicateMatches ?? []
  const duplicateMap = duplicateMatchesToMap(duplicateMatches)

  const archive = async (mapped: Record<string, unknown>, localId?: string) => {
    const realmId = typeof mapped._realmId === 'string' ? mapped._realmId : ''
    const entityType = typeof mapped._quickbooksEntity === 'string' ? mapped._quickbooksEntity : ''
    if (!realmId || !entityType || !mapped._quickbooksRaw) return
    const extendedQuickBooksModule=input.module.key.startsWith('qb-')
    const localTable = extendedQuickBooksModule ? undefined : LOCAL_TABLE_BY_MODULE[input.module.key] ?? input.module.key
    // Extended modules own native linking because their target table is
    // resource-specific. Never overwrite that link with a table-less ID.
    await archiveQuickBooksRecord({ companyId:input.ctx.companyId, realmId, entityType, row:mapped, localTable:localId&&!extendedQuickBooksModule ? localTable : undefined, localId:extendedQuickBooksModule?undefined:localId })
    if (localId && localTable) await materializeQuickBooksCustomFields({ companyId:input.ctx.companyId, entityType:localTable, entityId:localId, row:mapped })
  }

  const batchSize = Math.max(1, input.batchSize ?? DEFAULT_BATCH_SIZE)
  let batchesProcessed = 0
  for (let index = 0; index < validRows.length; index += batchSize) {
    if (input.assertActive) await input.assertActive()
    if (input.isCancelled && (await input.isCancelled())) {
      break
    }
    if (input.isPaused && (await input.isPaused())) { paused = true; break }

    const batch = validRows.slice(index, index + batchSize)

    for (const row of batch) {
      if (input.assertActive) await input.assertActive()
      if (input.isCancelled && (await input.isCancelled())) {
        break
      }
      if (input.isPaused && (await input.isPaused())) { paused = true; break }

      let createdId: string | undefined
      let recordStage = 'source_check'
      try {
        const duplicate = duplicateMap.get(row.rowNumber)
        const selectedAction = applyDuplicateStrategy(input.duplicateStrategy, Boolean(duplicate))
        // QuickBooks source identity is canonical. "Create duplicate" is a
        // merge/update for a source record that already exists locally.
        const action = selectedAction === 'create' && typeof row.mapped._realmId === 'string' ? 'update' : selectedAction
        recordStage='source_hash_check'
        // Replaying an unchanged, fully materialized record is a no-op only when
        // the chosen strategy skips duplicates. An explicit update must always
        // reach updateRecord so the user sees it counted as updated.
        const sourceUnchanged = action === 'skip'
          ? await measure('source_hash_check',()=>isQuickBooksRecordUnchanged(input.ctx.companyId,row.mapped))
          : false
        recordStage='materialization_status_check'
        const priorMaterialization=sourceUnchanged&&duplicate&&tracksQuickBooksMaterialization(input.module.key)?await measure('materialization_status_lookup',()=>getQuickBooksMaterializationStatus(input.ctx.companyId,input.module.key,duplicate.existingId,row.mapped)):null
        if(sourceUnchanged&&duplicate&&(!tracksQuickBooksMaterialization(input.module.key)||priorMaterialization==='completed')){
          recordStage='source_link_verification'
          await measure('source_link_archive',()=>archive(row.mapped, duplicate.existingId))
          await measure('source_link_verification',()=>assertQuickBooksRecordLinked(input.ctx.companyId,row.mapped,duplicate.existingId))
          skippedCount+=1
          skippedRecords.push(diagnostic(row, 'duplicate', duplicate))
          continue
        }
        recordStage='source_archive'
        await measure('source_archive',()=>archive(row.mapped))
        recordStage='dependency_validation'
        await measure('dependency_validation',()=>assertQuickBooksDependencies(input.module.key, row.mapped, input.ctx))
        // Parsers coerce business fields; protected provider metadata remains
        // authoritative and must accompany the parsed record to materializers.
        const record = { ...row.mapped, ...parser(row.mapped as Record<string, unknown>) }

        if (action === 'skip') {
          recordStage='source_link_verification'
          await measure('source_link_archive',()=>archive(row.mapped, duplicate?.existingId))
          skippedCount += 1
          skippedRecords.push(diagnostic(row, 'duplicate', duplicate))
          continue
        }

        if (action === 'update') {
          if (!duplicate) {
            skippedCount += 1
            skippedRecords.push(diagnostic(row, 'other'))
            errors.push({
              rowNumber: row.rowNumber,
              errorCode: 'DUPLICATE_NOT_FOUND',
              message: 'Expected duplicate record for update strategy but none was found',
              rawRow: row.mapped,
            })
            continue
          }
          recordStage='native_update'
          await measure('native_update',()=>input.module.updateRecord(duplicate.existingId, record, input.ctx))
          recordStage='source_link_verification'
          await measure('source_link_archive',()=>archive(row.mapped, duplicate.existingId))
          await measure('source_link_verification',()=>assertQuickBooksRecordLinked(input.ctx.companyId,row.mapped,duplicate.existingId))
          recordStage='accounting_materialization'
          const postingStarted=performance.now()
          try { await measure('accounting_materialization',()=>materializeQuickBooksAccounting({companyId:input.ctx.companyId,userId:input.ctx.userId,moduleKey:input.module.key,localId:duplicate.existingId,sourceRow:row.mapped}));input.trace?.accumulate('posting',performance.now()-postingStarted) }
          catch(error){input.trace?.accumulate('posting',performance.now()-postingStarted,true);throw error}
          recordStage='accounting_verification'
          await measure('accounting_verification',()=>assertQuickBooksAccountingCompleted(input.module.key, input.ctx.companyId, duplicate.existingId, row.mapped))
          updatedCount += 1
          continue
        }

        recordStage='native_create'
        const created = await measure('native_create',()=>input.module.createRecord(record, input.ctx))
        createdId = created.id
        if (created.archiveOnly) {
          // The module intentionally produced no native row (e.g. every line of a
          // QuickBooks InventoryAdjustment was a zero-quantity no-op) and already
          // recorded why via a NATIVE_MATERIALIZATION_BLOCKED / LOSSLESS_ARCHIVE_ONLY
          // warning. `created.id` is the archive row's id, not a native id — there
          // is nothing to link, so source-link verification does not apply here.
          // This is an expected skip, never an import failure.
          recordStage='source_link_archive'
          await measure('source_link_archive',()=>archive(row.mapped))
          skippedCount += 1
          skippedRecords.push(diagnostic(row, 'unsupported_type'))
          continue
        }
        recordStage='source_link_verification'
        await measure('source_link_archive',()=>archive(row.mapped, created.id))
        await measure('source_link_verification',()=>assertQuickBooksRecordLinked(input.ctx.companyId,row.mapped,created.id))
        recordStage='accounting_materialization'
        const postingStarted=performance.now()
        try { await measure('accounting_materialization',()=>materializeQuickBooksAccounting({companyId:input.ctx.companyId,userId:input.ctx.userId,moduleKey:input.module.key,localId:created.id,sourceRow:row.mapped}));input.trace?.accumulate('posting',performance.now()-postingStarted) }
        catch(error){input.trace?.accumulate('posting',performance.now()-postingStarted,true);throw error}
        recordStage='accounting_verification'
        await measure('accounting_verification',()=>assertQuickBooksAccountingCompleted(input.module.key, input.ctx.companyId, created.id, row.mapped))
        importedCount += 1
      } catch (err) {
        let rollbackMessage: string | undefined
        if (createdId && input.module.rollbackCreatedRecord) {
          try { await measure('rollback_created_record',()=>input.module.rollbackCreatedRecord!(createdId!, input.ctx)) }
          catch (rollbackError) { rollbackMessage = normalizeImportError(rollbackError).message }
        }
        const normalized = normalizeImportError(err)
        failedCount += 1
        errors.push({
          rowNumber: row.rowNumber,
          errorCode: normalized.errorCode,
          message: rollbackMessage ? `${recordStage}: ${normalized.message} Cleanup also failed: ${rollbackMessage}` : `${recordStage}: ${normalized.message}`,
          details: { ...normalized.details, stage:recordStage },
          rawRow: { ...row.mapped, _importError: { ...normalized.details, stage:recordStage } },
        })
      }
    }

    if (input.onProgress) {
      await input.onProgress(Math.min((input.startAt ?? 0) + index + batch.length, allValidRows.length), allValidRows.length, { importedCount, updatedCount, skippedCount, failedCount })
    }
    batchesProcessed += 1
    if (input.maxBatches && batchesProcessed >= input.maxBatches) break
  }

  return { importedCount, updatedCount, skippedCount, failedCount, errors, skippedRecords, paused }
}

type MasterPlanKind = 'import' | 'update' | 'skip' | 'skip_fast'

interface MasterPlan {
  row: MappedRow
  entityType: string
  kind: MasterPlanKind
  record?: Record<string, unknown>
  existingId?: string
  /** Set once the native row exists; drives the batched link write + verification. */
  localId?: string
  createdFresh?: boolean
  failed?: boolean
}

/**
 * Page-batched materialization for master-data QuickBooks modules
 * (see {@link QUICKBOOKS_BATCH_MASTER_MODULES}). Functionally identical to the
 * per-record loop in {@link processImport} — same duplicate-strategy decisions,
 * same dependency validation, same native create/update, same
 * link-verification invariant, same per-record error isolation & rollback — but
 * the `quickbooks_migration_records` / `quickbooks_migration_local_links` writes
 * and their verification reads, plus the cancel/pause/ownership probes, happen
 * once per page instead of ~6 times per record.
 *
 * All materialization work still completes before this function returns, i.e.
 * strictly before `sourcePage.commit()` in the import route (Phase 3 invariant).
 */
async function processQuickBooksMasterPage(input: ProcessImportInput): Promise<ImportProcessorResult> {
  const parser = input.module.parseImportRow ?? ((mapped) => mapped)
  const measure = <T>(name: string, operation: () => Promise<T> | T) => input.trace?.measureOperation(name, operation) ?? Promise.resolve(operation())
  const companyId = input.ctx.companyId
  const localTable = LOCAL_TABLE_BY_MODULE[input.module.key] ?? input.module.key
  const allValidRows = input.rows.filter((row) => input.validation.validRowNumbers.includes(row.rowNumber))
  const validRows = dependencyOrderedRows(input.module.key, allValidRows).slice(input.startAt ?? 0)
  const duplicateMap = duplicateMatchesToMap(input.duplicateMatches ?? [])

  const errors: ImportRowError[] = []
  const skippedRecords: SkippedRecordDiagnostic[] = []
  let importedCount = 0
  let updatedCount = 0
  let skippedCount = 0
  let failedCount = 0
  let paused = false

  const pushError = (row: MappedRow, stage: string, err: unknown, rollbackMessage?: string) => {
    const normalized = normalizeImportError(err)
    failedCount += 1
    errors.push({
      rowNumber: row.rowNumber,
      errorCode: normalized.errorCode,
      message: rollbackMessage ? `${stage}: ${normalized.message} Cleanup also failed: ${rollbackMessage}` : `${stage}: ${normalized.message}`,
      details: { ...normalized.details, stage },
      rawRow: { ...row.mapped, _importError: { ...normalized.details, stage } },
    })
  }

  const batchSize = Math.max(1, input.batchSize ?? DEFAULT_BATCH_SIZE)
  let batchesProcessed = 0
  for (let index = 0; index < validRows.length; index += batchSize) {
    if (input.assertActive) await input.assertActive()
    if (input.isCancelled && (await input.isCancelled())) break
    if (input.isPaused && (await input.isPaused())) { paused = true; break }

    const chunk = validRows.slice(index, index + batchSize)
    const realmId = String((chunk[0]?.mapped as Record<string, unknown>)?._realmId ?? '')

    // Phase A — one read of the migration-tracking state for the whole page.
    const pageEntityType = String((chunk[0]?.mapped as Record<string, unknown>)?._quickbooksEntity ?? '')
    const state = await measure('page_state_prefetch', () => loadQuickBooksMigrationPageState(companyId, realmId, chunk.map((row) => quickBooksSourceIdOf(row.mapped as Record<string, unknown>)), pageEntityType || undefined))

    // Phase B — classify every row in memory (no I/O). Mirrors the per-record
    // decision tree: skip-fast (unchanged & already materialized) → skip →
    // update (create-strategy on a QuickBooks source is a merge) → import.
    const plans: MasterPlan[] = []
    for (const row of chunk) {
      try {
        const mapped = row.mapped as Record<string, unknown>
        const entityType = String(mapped._quickbooksEntity ?? '')
        const duplicate = duplicateMap.get(row.rowNumber)
        const selectedAction = applyDuplicateStrategy(input.duplicateStrategy, Boolean(duplicate))
        const action = selectedAction === 'create' && typeof mapped._realmId === 'string' ? 'update' : selectedAction
        const sourceUnchanged = action === 'skip' && isQuickBooksRecordUnchangedInState(mapped, state)
        // Master modules never track accounting materialization, so an unchanged,
        // already-linked duplicate is a no-op beyond re-verifying the link.
        if (sourceUnchanged && duplicate) {
          plans.push({ row, entityType, kind: 'skip_fast', existingId: duplicate.existingId })
          continue
        }
        if (action === 'skip') {
          plans.push({ row, entityType, kind: 'skip', existingId: duplicate?.existingId })
          continue
        }
        if (action === 'update' && !duplicate) {
          skippedCount += 1
          skippedRecords.push(skipDiagnostic(row, 'other'))
          errors.push({ rowNumber: row.rowNumber, errorCode: 'DUPLICATE_NOT_FOUND', message: 'Expected duplicate record for update strategy but none was found', rawRow: mapped })
          continue
        }
        const record = { ...mapped, ...parser(mapped) }
        if (action === 'update') plans.push({ row, entityType, kind: 'update', record, existingId: duplicate!.existingId })
        else plans.push({ row, entityType, kind: 'import', record })
      } catch (err) {
        pushError(row, 'source_check', err)
      }
    }

    // Phase C — one multi-row upsert of the source rows (no native id yet), so a
    // crash before the natives are created still leaves the source preserved.
    if (input.assertActive) await input.assertActive()
    if (input.isCancelled && (await input.isCancelled())) break
    const sourceArchive = plans.filter((plan) => plan.kind !== 'skip_fast')
    if (sourceArchive.length) {
      await measure('source_archive_batch', () => archiveQuickBooksRecordsBatch(companyId, sourceArchive.map((plan) => ({ realmId, entityType: plan.entityType, row: plan.row.mapped as Record<string, unknown> }))))
    }

    // Phase D — per-record dependency validation + native create/update. Kept
    // sequential and per-record: this is the module-specific work with its own
    // side-effects, sequence allocation and rollback semantics.
    if (input.assertActive) await input.assertActive()
    for (const plan of plans) {
      if (plan.kind === 'skip_fast' || plan.kind === 'skip') {
        plan.localId = plan.existingId
        continue
      }
      let createdId: string | undefined
      let stage = 'dependency_validation'
      try {
        await measure('dependency_validation', () => assertQuickBooksDependencies(input.module.key, plan.row.mapped as Record<string, unknown>, input.ctx))
        if (plan.kind === 'update') {
          stage = 'native_update'
          await measure('native_update', () => input.module.updateRecord(plan.existingId!, plan.record!, input.ctx))
          plan.localId = plan.existingId
        } else {
          stage = 'native_create'
          const created = await measure('native_create', () => input.module.createRecord(plan.record!, input.ctx))
          createdId = created.id
          plan.localId = created.id
          plan.createdFresh = true
        }
      } catch (err) {
        let rollbackMessage: string | undefined
        if (createdId && input.module.rollbackCreatedRecord) {
          try { await measure('rollback_created_record', () => input.module.rollbackCreatedRecord!(createdId!, input.ctx)) }
          catch (rollbackError) { rollbackMessage = normalizeImportError(rollbackError).message }
        }
        plan.failed = true
        pushError(plan.row, stage, err, rollbackMessage)
      }
    }

    // Phase E — one multi-row upsert linking every materialized row to its native
    // id (quickbooks_migration_records.local_id + quickbooks_migration_local_links).
    if (input.assertActive) await input.assertActive()
    const linked = plans.filter((plan) => !plan.failed && plan.localId)
    if (linked.length) {
      await measure('link_archive_batch', () => archiveQuickBooksRecordsBatch(companyId, linked.map((plan) => ({ realmId, entityType: plan.entityType, row: plan.row.mapped as Record<string, unknown>, localTable, localId: plan.localId! }))))
    }
    for (const plan of linked) {
      const raw = parseQuickBooksRaw(plan.row.mapped as Record<string, unknown>)
      if (Array.isArray(raw.CustomField) && raw.CustomField.length) {
        try { await measure('custom_fields', () => materializeQuickBooksCustomFields({ companyId, entityType: localTable, entityId: plan.localId!, row: plan.row.mapped as Record<string, unknown> })) }
        catch (err) { plan.failed = true; pushError(plan.row, 'custom_fields', err) }
      }
    }

    // Phase F — one re-read of the tracking state; verify every link the same way
    // assertQuickBooksRecordLinked does per record. `skip` rows are not verified
    // (the per-record path does not verify them either).
    if (input.assertActive) await input.assertActive()
    const toVerify = linked.filter((plan) => !plan.failed && plan.kind !== 'skip')
    if (toVerify.length) {
      const verifyEntityType = String((toVerify[0]?.row.mapped as Record<string, unknown>)?._quickbooksEntity ?? '')
      const verifyState = await measure('link_verification_batch', () => loadQuickBooksMigrationPageState(companyId, realmId, toVerify.map((plan) => quickBooksSourceIdOf(plan.row.mapped as Record<string, unknown>)), verifyEntityType || undefined))
      for (const plan of toVerify) {
        const failure = verifyQuickBooksRecordLinked(plan.row.mapped as Record<string, unknown>, plan.localId!, verifyState)
        if (!failure) continue
        plan.failed = true
        if (plan.createdFresh && input.module.rollbackCreatedRecord) {
          try { await input.module.rollbackCreatedRecord(plan.localId!, input.ctx) } catch { /* best-effort compensation */ }
        }
        pushError(plan.row, 'source_link_verification', new Error(failure))
      }
    }

    // Phase G — tally. Errors were already counted by pushError.
    for (const plan of plans) {
      if (plan.failed) continue
      if (plan.kind === 'import') importedCount += 1
      else if (plan.kind === 'update') updatedCount += 1
      else {
        skippedCount += 1
        skippedRecords.push(skipDiagnostic(plan.row, 'duplicate', duplicateMap.get(plan.row.rowNumber)))
      }
    }

    if (input.onProgress) {
      await input.onProgress(Math.min((input.startAt ?? 0) + index + chunk.length, allValidRows.length), allValidRows.length, { importedCount, updatedCount, skippedCount, failedCount })
    }
    batchesProcessed += 1
    if (input.maxBatches && batchesProcessed >= input.maxBatches) break
  }

  return { importedCount, updatedCount, skippedCount, failedCount, errors, skippedRecords, paused }
}
