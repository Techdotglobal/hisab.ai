import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { planMigrationStartBootstrap } from '../../src/lib/import-export/wizard/migration-session-bootstrap'
import { restoreLifecycleFromSession } from '../../src/lib/import-export/wizard/migration-session'
import { orderQuickBooksMigrationResources } from '../../src/lib/import-export/quickbooks/dependency-order'
import { mergeImportJobProgress } from '../../src/lib/import-export/jobs/progress-merge'
import type { HydratedMigrationSession } from '../../src/lib/import-export/wizard/migration-session'
import type {
  ModuleLifecycleEntry,
  ModuleLifecyclePhase,
  ModuleLifecycleState,
} from '../../src/lib/import-export/wizard/module-lifecycle'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

function moduleEntry(
  key: string,
  order: number,
  phase: ModuleLifecyclePhase,
  jobId: string | null,
): ModuleLifecycleEntry {
  return {
    key,
    moduleKey: `qb-${key}`,
    label: key,
    order,
    phase,
    jobId,
    estimate: { records: 1, batches: 1, durationMs: 1_000 },
    preview: null,
    failure: null,
    unsupported: null,
    progress: null,
    queuePosition: null,
    durationMs: null,
    warningCount: 0,
  }
}

function preferencesThenAccountsSession(): HydratedMigrationSession {
  const resources = orderQuickBooksMigrationResources([
    { key: 'preferences', label: 'Company Preferences', moduleKey: 'qb-preferences' },
    { key: 'accounts', label: 'Accounts', moduleKey: 'qb-accounts' },
  ])
  const lifecycle: ModuleLifecycleState = {
    preferences: moduleEntry('preferences', 0, 'completed', 'pref-job'),
    accounts: moduleEntry('accounts', 1, 'ready', null),
  }
  const jobs = {
    preferences: {
      id: 'pref-job',
      moduleKey: 'qb-preferences',
      status: 'completed',
      totalRows: 1,
      processedRows: 1,
      importedCount: 1,
      updatedCount: 0,
      skippedCount: 0,
      failedCount: 0,
    },
  }
  const config = {
    kind: 'quickbooks_migration' as const,
    provider: 'quickbooks' as const,
    state: 'running' as const,
    selectedModules: resources,
    duplicateStrategy: 'skip' as const,
    modules: Object.values(lifecycle).map((entry) => ({
      key: entry.key,
      moduleKey: entry.moduleKey,
      label: entry.label,
      order: entry.order,
      phase: entry.phase,
      jobId: entry.jobId,
      estimate: entry.estimate,
      preview: entry.preview,
      failure: entry.failure,
      unsupported: entry.unsupported,
      warningCount: entry.warningCount,
    })),
    importJobIds: { preferences: 'pref-job' },
    startedAt: '2026-08-06T15:43:25.531Z',
    sourceLabel: 'QuickBooks Online',
    companyName: 'Sandbox Co',
    currency: 'USD',
    orchestrationOwner: 'worker' as const,
  }
  return {
    id: 'session-advance-1',
    companyId: 'company-1',
    userId: 'user-1',
    step: 'import',
    status: 'IN_PROGRESS',
    createdAt: '2026-08-06T15:43:25.648Z',
    updatedAt: '2026-08-06T15:43:25.648Z',
    lifecycle: restoreLifecycleFromSession(config, jobs),
    jobs,
    config,
  }
}

test('HTTP import still resolves the tenant from cookies at the request boundary', () => {
  const tenant = read('src/lib/tenant.ts')
  const server = read('src/lib/supabase/server.ts')
  const route = read('src/app/api/import-export/[module]/import/route.ts')
  // POST is wrapped by guarded('imports.run', handlePost); handlePost holds the request-boundary logic.
  assert.match(route, /export const POST = guarded\('imports\.run', handlePost\)/)
  const postHandler = route.slice(
    route.indexOf('async function handlePost'),
    route.indexOf('export async function runImportJobStep'),
  )

  assert.match(server, /const cookieStore = await cookies\(\)/)
  assert.match(tenant, /from 'next\/headers'/)
  assert.match(tenant, /const cookieStore = await cookies\(\)/)
  assert.match(tenant, /cookieStore\.get\(COMPANY_COOKIE\)/)
  assert.match(route, /const companyId = await resolveCompanyId\(\)/)
  assert.match(postHandler, /handleImport\(request/)
  assert.doesNotMatch(postHandler, /withCompanyContext/)
  assert.doesNotMatch(postHandler, /companyIdOverride/)
})

test('background worker creates and advances import jobs with explicit companyId, never cookies', () => {
  const service = read('src/lib/import-export/jobs/import-job.service.ts')
  const session = read('src/lib/import-export/wizard/migration-session.service.ts')
  const workers = read('src/lib/platform/jobs/workers.ts')
  const tenant = read('src/lib/tenant.ts')
  const bootstrap = session.slice(
    session.indexOf('export async function bootstrapQuickBooksMigrationQueue'),
    session.indexOf('export async function advanceQuickBooksMigrationAfterImportJob'),
  )
  const handler = workers.slice(
    workers.indexOf("registerJobHandler('QUICKBOOKS_IMPORT_STEP'"),
    workers.indexOf("registerJobHandler('AUTOMATION_RUN'"),
  )
  const wrapped = handler.slice(handler.indexOf('return withCompanyContext'))

  assert.match(service, /companyId\?: string/)
  assert.match(service, /resolveCompanyIdOrThrow\(input\.companyId\)/)
  assert.match(bootstrap, /createImportJob\(\{/)
  assert.match(bootstrap, /companyId,/)
  assert.match(bootstrap, /setImportJobStatus\(created\.id, 'pending', companyId\)/)
  assert.match(handler, /withCompanyContext\(companyId/)
  assert.match(wrapped, /runImportJobStep\(/)
  assert.match(wrapped, /coordinateQuickBooksMigrationAfterStep\(/)
  assert.match(workers, /getImportJob\(input\.importJobId, input\.companyId\)/)
  assert.match(workers, /advanceQuickBooksMigrationAfterImportJob\(/)
  assert.ok(workers.indexOf('getImportJob(input.importJobId, input.companyId)') < workers.indexOf('advanceQuickBooksMigrationAfterImportJob'))
  assert.doesNotMatch(handler, /cookies\(/)
  assert.doesNotMatch(handler, /headers\(/)
  assert.match(tenant, /if\(background\?\.companyId\)return background\.companyId/)
  const alsReturn = tenant.indexOf('if(background?.companyId)return background.companyId')
  const cookieCall = tenant.indexOf('await cookies()')
  assert.ok(alsReturn >= 0 && cookieCall > alsReturn)
})

test('a completed qb-preferences job advances the session to the next module', () => {
  const session = preferencesThenAccountsSession()
  const plan = planMigrationStartBootstrap(session)
  assert.equal(plan.type, 'create-and-enqueue')
  if (plan.type === 'create-and-enqueue') {
    assert.equal(plan.module.key, 'accounts')
    assert.equal(plan.module.moduleKey, 'qb-accounts')
  }

  const service = read('src/lib/import-export/wizard/migration-session.service.ts')
  const advance = service.slice(
    service.indexOf('export async function advanceQuickBooksMigrationAfterImportJob'),
    service.indexOf('export async function updateQuickBooksMigrationSession'),
  )
  assert.match(advance, /bootstrapQuickBooksMigrationQueue\(\{ session, userId, companyIdOverride: companyId \}\)/)
  assert.match(advance, /nextModule: next\.module\.key/)
  assert.doesNotMatch(advance, /state: 'completed'/)
})

test('retrying a completed import job does not duplicate records or grow processedRows', () => {
  const route = read('src/app/api/import-export/[module]/import/route.ts')
  const service = read('src/lib/import-export/jobs/import-job.service.ts')
  const step = route.slice(route.indexOf('export async function runImportJobStep'))

  assert.match(step, /terminal_replay_skipped/)
  assert.match(step, /job\.status === 'completed' \|\| job\.status === 'failed' \|\| job\.status === 'cancelled'/)
  assert.ok(step.indexOf('terminal_replay_skipped') < step.indexOf("setImportJobStatus(job.id, 'processing'"))
  assert.match(route, /\['completed', 'failed', 'cancelled'\]\.includes\(existingJob\.status\)/)
  assert.match(service, /completed_job_immutable/)
  assert.match(service, /\.neq\('status', 'completed'\)/)
  assert.match(service, /if \(job\.status === 'completed'\) return/)

  const stale = mergeImportJobProgress({
    status: 'completed',
    processedRows: 4,
    totalRows: 4,
    importedCount: 4,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    validRows: 4,
    invalidRows: 0,
    warningCount: 0,
    progressSnapshot: { processedRecords: 4, estimatedTotalRecords: 4, importedCount: 4 },
  }, {
    processedRows: 8,
    totalRows: 4,
    counts: { importedCount: 8, updatedCount: 0, skippedCount: 0, failedCount: 0 },
    progressSnapshot: { processedRecords: 8, importedCount: 8 },
  })
  assert.equal(stale, 'stale_completed')
})

test('the QuickBooks worker path never calls Next.js request-scoped APIs', () => {
  const worker = read('worker/index.ts')
  const workers = read('src/lib/platform/jobs/workers.ts')
  const queue = read('src/lib/platform/jobs/queue.ts')
  const session = read('src/lib/import-export/wizard/migration-session.service.ts')
  const jobs = read('src/lib/import-export/jobs/import-job.service.ts')
  const route = read('src/app/api/import-export/[module]/import/route.ts')
  const handler = workers.slice(
    workers.indexOf("registerJobHandler('QUICKBOOKS_IMPORT_STEP'"),
    workers.indexOf("registerJobHandler('AUTOMATION_RUN'"),
  )

  for (const source of [worker, queue, session, jobs, route]) {
    assert.doesNotMatch(source, /from 'next\/headers'/)
    assert.doesNotMatch(source, /from "next\/headers"/)
    assert.doesNotMatch(source, /cookies\(\)/)
    assert.doesNotMatch(source, /headers\(\)/)
  }
  assert.doesNotMatch(workers, /from 'next\/headers'/)
  assert.doesNotMatch(handler, /createClient\(\)/)
  assert.match(handler, /withCompanyContext\(companyId/)
  assert.match(jobs, /resolveCompanyIdOrThrow\(input\.companyId\)/)
})
