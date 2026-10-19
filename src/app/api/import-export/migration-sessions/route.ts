import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { apiError } from '@/lib/import-export/api-helpers'
import {
  createQuickBooksMigrationSession,
  findActiveQuickBooksMigrationSession,
  findLatestQuickBooksMigrationSession,
  listQuickBooksMigrationSessions,
  pollQuickBooksMigrationSession,
} from '@/lib/import-export/wizard/migration-session.service'
import type { DuplicateStrategy } from '@/lib/import-export/types'
import type { ModuleLifecycleState, SelectableResource } from '@/lib/import-export/wizard/module-lifecycle'
import type { MigrationSessionState } from '@/lib/import-export/wizard/migration-session'
import type { MigrationActivityCursors } from '@/lib/import-export/wizard/migration-poll-payload'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function parseActivityCursors(request: Request, url: URL): MigrationActivityCursors {
  const header = request.headers.get('x-migration-activity-cursors')
  const query = url.searchParams.get('activityCursors')
  const raw = header || query
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const cursors: MigrationActivityCursors = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) cursors[key] = value
    }
    return cursors
  } catch {
    return {}
  }
}

/** Detect or list QuickBooks migration sessions. Never creates one. */
async function handleGet(request: Request) {
  try {
    await requireAccountingAdmin()
    const url = new URL(request.url)
    if (url.searchParams.get('list') === 'true') {
      const page = Number(url.searchParams.get('page') ?? '1')
      const limit = Number(url.searchParams.get('limit') ?? '25')
      const status = (url.searchParams.get('status') ?? '') as MigrationSessionState | ''
      const result = await listQuickBooksMigrationSessions({ page, limit, status })
      return Response.json(result, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
    }

    // Compact poll mode used by MigrationSessionProvider. Full { session } remains the default.
    if (url.searchParams.get('poll') === '1') {
      const includeLatest = url.searchParams.get('includeLatest') === 'true'
      const includeStatic = url.searchParams.get('static') !== '0'
      const includeActivityEvents = url.searchParams.get('activity') !== '0'
      const previousLiveFingerprint = request.headers.get('x-migration-live-fingerprint')
      const { poll } = await pollQuickBooksMigrationSession({
        includeLatest,
        includeStatic,
        includeActivityEvents,
        activityCursors: parseActivityCursors(request, url),
        previousLiveFingerprint,
      })
      return Response.json({ poll }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
    }

    const includeLatest = url.searchParams.get('includeLatest') === 'true'
    const session = includeLatest
      ? await findLatestQuickBooksMigrationSession()
      : await findActiveQuickBooksMigrationSession()
    return Response.json({ session }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
  } catch (error) {
    return apiError(error)
  }
}

/** Create a persistent QuickBooks migration session. Rejects if one is already active. */
async function handlePost(request: Request) {
  try {
    const user = await requireAccountingAdmin()
    const body = await request.json() as {
      selectedModules?: SelectableResource[]
      duplicateStrategy?: DuplicateStrategy
      lifecycle?: ModuleLifecycleState
      sourceLabel?: string | null
      companyName?: string | null
      currency?: string | null
      snapshotId?: string | null
    }

    const existing = await findActiveQuickBooksMigrationSession()
    if (existing) {
      return Response.json({
        error: 'Migration already running',
        code: 'MIGRATION_ALREADY_RUNNING',
        session: existing,
      }, { status: 409 })
    }

    if (!Array.isArray(body.selectedModules) || body.selectedModules.length === 0) {
      return Response.json({ error: 'selectedModules is required' }, { status: 400 })
    }
    if (!body.lifecycle || typeof body.lifecycle !== 'object') {
      return Response.json({ error: 'lifecycle is required' }, { status: 400 })
    }

    const session = await createQuickBooksMigrationSession({
      userId: user.id,
      selectedModules: body.selectedModules,
      duplicateStrategy: body.duplicateStrategy ?? 'skip',
      lifecycle: body.lifecycle,
      sourceLabel: body.sourceLabel,
      companyName: body.companyName,
      currency: body.currency,
      snapshotId: typeof body.snapshotId === 'string' ? body.snapshotId : null,
    })

    return Response.json({ session }, { status: 201 })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
export const POST = guarded('imports.run', handlePost)
