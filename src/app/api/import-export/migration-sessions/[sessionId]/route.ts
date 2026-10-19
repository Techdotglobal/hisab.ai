import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { apiError } from '@/lib/import-export/api-helpers'
import {
  getQuickBooksMigrationSession,
  pollQuickBooksMigrationSession,
  updateQuickBooksMigrationSession,
} from '@/lib/import-export/wizard/migration-session.service'
import type { DuplicateStrategy } from '@/lib/import-export/types'
import type { ModuleLifecycleState, SelectableResource } from '@/lib/import-export/wizard/module-lifecycle'
import type { MigrationSessionState, MigrationSessionStep } from '@/lib/import-export/wizard/migration-session'
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

async function handleGet(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    await requireAccountingAdmin()
    const { sessionId } = await params
    const url = new URL(request.url)

    if (url.searchParams.get('poll') === '1') {
      const includeStatic = url.searchParams.get('static') !== '0'
      const includeActivityEvents = url.searchParams.get('activity') !== '0'
      const previousLiveFingerprint = request.headers.get('x-migration-live-fingerprint')
      const { poll } = await pollQuickBooksMigrationSession({
        sessionId,
        includeStatic,
        includeActivityEvents,
        activityCursors: parseActivityCursors(request, url),
        previousLiveFingerprint,
      })
      if (!poll) return Response.json({ error: 'Migration session not found' }, { status: 404 })
      return Response.json({ poll }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
    }

    const session = await getQuickBooksMigrationSession(sessionId)
    if (!session) return Response.json({ error: 'Migration session not found' }, { status: 404 })
    return Response.json({ session }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
  } catch (error) {
    return apiError(error)
  }
}

async function handlePatch(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    await requireAccountingAdmin()
    const { sessionId } = await params
    const body = await request.json() as {
      lifecycle?: ModuleLifecycleState
      selectedModules?: SelectableResource[]
      duplicateStrategy?: DuplicateStrategy
      step?: MigrationSessionStep
      state?: MigrationSessionState
    }

    const session = await updateQuickBooksMigrationSession({
      sessionId,
      lifecycle: body.lifecycle,
      selectedModules: body.selectedModules,
      duplicateStrategy: body.duplicateStrategy,
      step: body.step,
      state: body.state,
    })

    return Response.json({ session })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
export const PATCH = guarded('imports.run', handlePatch)
