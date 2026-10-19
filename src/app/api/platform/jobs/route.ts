import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse } from '@/lib/authz'
import { processJobBatch } from '@/lib/platform/jobs/workers'
import { getQueueStats } from '@/lib/platform/jobs/queue'
import { isCronAuthorized, requirePlatformAdmin } from '@/lib/platform/require-admin'

async function handlePost(request: Request) {
  try {
    if (!isCronAuthorized(request)) {
      await requirePlatformAdmin()
    }
    // Keep each invocation bounded; long-running migrations enqueue their next unit.
    const result = await processJobBatch(1)
    return Response.json(result)
  } catch (error) {
    return authzErrorResponse(error)
  }
}

async function handleGet() {
  try {
    await requireAuth()
    const stats = await getQueueStats()
    return Response.json({ stats })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('platform.manage', handleGet)
export const POST = guarded('platform.manage', handlePost)
