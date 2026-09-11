export type FileFormat = 'csv' | 'xlsx'

export type DuplicateStrategy = 'skip' | 'update' | 'create'

export type ImportJobStatus =
  | 'pending'
  | 'parsing'
  | 'mapping'
  | 'validating'
  | 'processing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type FieldType =
  | 'string'
  | 'email'
  | 'phone'
  | 'number'
  | 'date'
  | 'boolean'
  | 'currency'
  | 'vat'

export type ValidationSeverity = 'error' | 'warning'

export interface FieldDefinition {
  key: string
  label: string
  type: FieldType
  required?: boolean
  importable?: boolean
  exportable?: boolean
  exportOrder?: number
  description?: string
}

/** Column in a hisab.ai official import template (QuickBooks-style). */
export interface OfficialTemplateColumn {
  /** Exact header text in the downloadable template file. */
  header: string
  /** Internal field key used after mapping. */
  fieldKey: string
  required?: boolean
  /** Example value shown in the downloadable template row. */
  example: string
}

/** Module-defined official import template — headers match skips manual mapping. */
export interface OfficialImportTemplate {
  id: string
  name: string
  columns: OfficialTemplateColumn[]
}

export interface ModuleDefinition {
  key: string
  displayName: string
  fields: FieldDefinition[]
  duplicateKeys: string[]
  /** Official hisab.ai import templates for this module. */
  officialTemplates?: OfficialImportTemplate[]
  /**
   * Normalize mapped rows from an official template into internal field shape.
   * Called after column mapping when officialTemplateId is set.
   */
  transformOfficialRow?: (
    mapped: Record<string, unknown>,
    templateId: string,
  ) => Record<string, unknown>
  findDuplicate: (record: Record<string, unknown>, ctx: ImportContext) => Promise<{ id: string; matchedOn: string[] } | null>
  /**
   * `archiveOnly: true` signals that the source row was preserved (archived)
   * but intentionally has no native counterpart — e.g. a QuickBooks extended
   * entity whose materialization was legitimately skipped (already recorded as
   * a warning by the module itself). `id` in that case is the archive row's id,
   * not a native record id. Callers must treat this as a skip, never as a
   * successful native materialization, and must not run source-link
   * verification against it.
   */
  createRecord: (record: Record<string, unknown>, ctx: ImportContext) => Promise<{ id: string; archiveOnly?: boolean }>
  updateRecord: (id: string, record: Record<string, unknown>, ctx: ImportContext) => Promise<void>
  /** Compensates a failed create before it can be reported as imported. */
  rollbackCreatedRecord?: (id: string, ctx: ImportContext) => Promise<void>
  exportRecords: (filters: Record<string, string>, ctx: ImportContext) => Promise<unknown[]>
  mapExportRow: (record: unknown) => Record<string, string | number | boolean | null>
  parseImportRow?: (mapped: Record<string, unknown>) => Record<string, unknown>
  /** Batch duplicate lookup — avoids N+1 queries during validate/import. */
  findDuplicatesBatch?: (
    rows: MappedRow[],
    ctx: ImportContext,
  ) => Promise<DuplicateMatch[]>
}

export interface ParsedFile {
  headers: string[]
  rows: Record<string, string>[]
  format: FileFormat
}

export interface ColumnMapping {
  [sourceHeader: string]: string | null
}

export interface MappedRow {
  rowNumber: number
  source: Record<string, string>
  mapped: Record<string, unknown>
}

export interface ValidationIssue {
  rowNumber: number
  fieldKey?: string
  code: string
  message: string
  severity: ValidationSeverity
}

export interface ValidationResult {
  issues: ValidationIssue[]
  errorCount: number
  warningCount: number
  validRowNumbers: number[]
  invalidRowNumbers: number[]
  summaryByCode: Record<string, number>
}

export interface DuplicateMatch {
  rowNumber: number
  existingId: string
  matchedOn: string[]
}

export interface ImportContext {
  companyId: string
  userId: string
  performance?: {
    measureOperation<T>(name: string, operation: () => Promise<T> | T): Promise<T>
  }
}

export interface ImportProcessorResult {
  importedCount: number
  updatedCount: number
  skippedCount: number
  failedCount: number
  errors: ImportRowError[]
  skippedRecords: SkippedRecordDiagnostic[]
  paused?: boolean
}

export type SkipReason = 'duplicate' | 'inactive' | 'filtered' | 'validation_failed' | 'unsupported_type' | 'other'

export interface SkippedRecordDiagnostic {
  rowNumber: number
  sourceId?: string
  recordName?: string
  reason: SkipReason
  duplicateKey?: string
  existingRecordId?: string
}

export interface ImportRowError {
  rowNumber: number
  fieldKey?: string
  errorCode: string
  message: string
  rawRow?: Record<string, unknown>
  details?: import('./import/import-error').ImportErrorDetails
}

export interface ImportJobRecord {
  id: string
  companyId: string
  userId: string
  moduleKey: string
  migrationSessionId?: string | null
  migrationResourceKey?: string | null
  filename: string
  fileFormat: FileFormat
  duplicateStrategy: DuplicateStrategy | null
  status: ImportJobStatus
  totalRows: number
  importedCount: number
  updatedCount: number
  skippedCount: number
  failedCount: number
  processedRows: number
  validRows: number | null
  invalidRows: number | null
  warningCount: number | null
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  mappingSnapshot: Record<string, string> | null
  validationSummary: Record<string, number> | null
  errorSummary: Record<string, number> | null
  createdAt: string
  updatedAt: string
  batchSize?: number
  batchCursor?: number
  retryCount?: number
  pausedAt?: string | null
  lastHeartbeatAt?: string | null
  payloadSnapshot?: Record<string, unknown> | null
  progressSnapshot?: MigrationProgressSnapshot | null
  activityEvents?: MigrationActivityEvent[]
  skipSummary?: Record<string, number> | null
}

export interface MigrationActivityEvent {
  id: string
  at: string
  type: string
  message: string
  module?: string | null
  stage?: string | null
  batch?: number | null
  records?: number | null
  durationMs?: number | null
  warningCount?: number | null
}

/** Module-level failure persisted on `import_jobs.progress_snapshot.failure`. */
export interface ModuleFailureSnapshot {
  message: string
  stage: string | null
  errorCode: string | null
  errorType: string | null
  correlationId: string | null
  retryable: boolean
  rowNumber: number | null
  /** Present only outside production — never the primary Errors panel copy. */
  stack: string | null
}

export interface MigrationProgressSnapshot {
  currentModule?: string | null
  currentStage?: string | null
  currentBatch?: number | null
  totalBatches?: number | null
  currentRecord?: string | null
  estimatedTotalRecords?: number | null
  processedRecords?: number
  importedCount?: number
  updatedCount?: number
  skippedCount?: number
  failedCount?: number
  throughput?: number | null
  averageThroughput?: number | null
  apiRequests?: number
  databaseQueries?: number
  databaseWrites?: number
  databaseTimeMs?: number
  apiTimeMs?: number
  retryCount?: number
  memoryBytes?: number | null
  startedAt?: string | null
  /** Cumulative time spent inside claimed worker steps; excludes queue and pause time. */
  activeProcessingMs?: number
  progressPercent?: number
  stages?: Record<string, { status: 'pending' | 'running' | 'completed' | 'failed'; durationMs?: number; progress?: number }>
  failure?: ModuleFailureSnapshot | null
}

export interface MappingTemplateRecord {
  id: string
  companyId: string
  moduleKey: string
  name: string
  isDefault: boolean
  columnMapping: Record<string, string>
  headerFingerprint: string | null
  createdById: string | null
  createdAt: string
  updatedAt: string
}

export const TERMINAL_JOB_STATUSES: ImportJobStatus[] = ['completed', 'failed', 'cancelled']

export const ACTIVE_JOB_STATUSES: ImportJobStatus[] = [
  'pending',
  'parsing',
  'mapping',
  'validating',
  'processing',
]

/** File imports are streamed/batched by the job runner; no QuickBooks-sized row ceiling. */
export const MAX_IMPORT_ROWS = Number.MAX_SAFE_INTEGER
export const MAX_EXPORT_ROWS = 50_000
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
