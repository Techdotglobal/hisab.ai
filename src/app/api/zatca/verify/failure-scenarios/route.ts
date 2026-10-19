import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { runFailureScenarios } from '@/lib/zatca/testing/failure-scenarios'

/**
 * GET /api/zatca/verify/failure-scenarios
 * Runs intentional invalid-input scenarios to verify error handling.
 */
async function handleGet() {
  try {
    await requireAuth()
    const results = runFailureScenarios()
    const passed = results.filter((r) => r.passed).length
    return Response.json({
      summary: { total: results.length, passed, failed: results.length - passed },
      results,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('integrations.manage', handleGet)
