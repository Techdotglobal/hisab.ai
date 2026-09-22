/**
 * Regression for the NETKOM "false completion" defect: a materializer returning null (an unresolvable dependency, an
 * unsupported record shape) was recorded as a 'unsupported_type'/'other' skip, not an error, so a job whose every row hit
 * that path finished with 0 imported/updated AND 0 failed — and reported `status: 'completed'`. Confirmed on production:
 * `qb-transfers` (31/31 rows skipped, 0 imported) and `qb-inventory-adjustments` both reported "completed".
 *
 * `computeImportJobStatus`/`silentlySkippedEverything`/`buildFinalJobFailure` (migration-failure.ts) are the pure decision
 * extracted from `src/app/api/import-export/[module]/import/route.ts`'s final-page status computation.
 *
 * Run: npx tsx --test tests/integrations/quickbooks-import-job-completion-semantics.test.ts
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFinalJobFailure, computeImportJobStatus, silentlySkippedEverything,
} from '../../src/lib/import-export/wizard/migration-failure'
import type { ImportRowError, SkipReason } from '../../src/lib/import-export/types'

const skip = (reason: SkipReason, n = 1) => Array.from({ length: n }, () => ({ reason }))

test('a job where every row was silently skipped (materializer returned null) reports failed, not completed', () => {
  const status = computeImportJobStatus({ importedCount: 0, updatedCount: 0, failedCount: 0, skippedRecords: skip('unsupported_type', 31) })
  assert.equal(status, 'failed')
})

test('the same all-"other"-skip shape also reports failed', () => {
  assert.equal(computeImportJobStatus({ importedCount: 0, updatedCount: 0, failedCount: 0, skippedRecords: skip('other', 2) }), 'failed')
})

test('a job that legitimately skips only because every row already exists (duplicate) still reports completed', () => {
  const status = computeImportJobStatus({ importedCount: 0, updatedCount: 0, failedCount: 0, skippedRecords: skip('duplicate', 50) })
  assert.equal(status, 'completed')
})

test('inactive / filtered / validation_failed skips keep their existing "completed, nothing to do" meaning', () => {
  for (const reason of ['inactive', 'filtered', 'validation_failed'] as SkipReason[]) {
    assert.equal(computeImportJobStatus({ importedCount: 0, updatedCount: 0, failedCount: 0, skippedRecords: skip(reason, 3) }), 'completed', reason)
  }
})

test('a mix of duplicate and unsupported_type skips (not ALL silent) still reports completed', () => {
  const status = computeImportJobStatus({ importedCount: 0, updatedCount: 0, failedCount: 0, skippedRecords: [...skip('duplicate', 5), ...skip('unsupported_type', 1)] })
  assert.equal(status, 'completed')
})

test('any successful import or update always reports completed, even alongside unsupported_type skips', () => {
  assert.equal(computeImportJobStatus({ importedCount: 1, updatedCount: 0, failedCount: 0, skippedRecords: skip('unsupported_type', 30) }), 'completed')
  assert.equal(computeImportJobStatus({ importedCount: 0, updatedCount: 1, failedCount: 0, skippedRecords: skip('other', 30) }), 'completed')
})

test('an explicit row failure still reports failed exactly as before (existing behavior preserved)', () => {
  assert.equal(computeImportJobStatus({ importedCount: 0, updatedCount: 0, failedCount: 3, skippedRecords: [] }), 'failed')
})

test('a job with 0 rows total (nothing to skip, nothing to fail) reports completed', () => {
  assert.equal(computeImportJobStatus({ importedCount: 0, updatedCount: 0, failedCount: 0, skippedRecords: [] }), 'completed')
})

test('silentlySkippedEverything is the exact predicate computeImportJobStatus relies on', () => {
  assert.equal(silentlySkippedEverything(skip('unsupported_type', 2)), true)
  assert.equal(silentlySkippedEverything(skip('duplicate', 2)), false)
  assert.equal(silentlySkippedEverything([]), false, 'no skips at all is not "silently skipped everything"')
})

test('buildFinalJobFailure summarizes real row errors when present', () => {
  const errors: ImportRowError[] = [{ rowNumber: 1, message: 'Vendor not found', errorCode: 'MISSING_DEPENDENCY' }]
  const failure = buildFinalJobFailure(errors, [])
  assert.equal(failure.message, 'Vendor not found')
  assert.equal(failure.errorCode, 'MISSING_DEPENDENCY')
})

test('buildFinalJobFailure synthesizes a clear message for an all-skipped job with no row errors', () => {
  const failure = buildFinalJobFailure([], skip('unsupported_type', 31))
  assert.equal(failure.errorCode, 'ALL_ROWS_SKIPPED')
  assert.match(failure.message, /31 of 31/)
  assert.equal(failure.retryable, false)
})
