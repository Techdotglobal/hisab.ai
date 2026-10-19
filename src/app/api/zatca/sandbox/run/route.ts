import { guarded } from '@/lib/permissions/guard'
import { requireZatcaAdmin } from '@/lib/zatca/authz'
import { ZatcaForbiddenError } from '@/lib/zatca/authz'
import { runAllSandboxScenarios } from '@/lib/zatca/testing/sandbox-runner'

/**
 * POST /api/zatca/sandbox/run
 * Runs all sandbox E2E test scenarios (mock mode). Development / admin only.
 */
async function handlePost() {
  try {
    await requireZatcaAdmin()

    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_ZATCA_SANDBOX !== 'true') {
      return Response.json({ error: 'Sandbox runner is disabled in production' }, { status: 403 })
    }

    const results = await runAllSandboxScenarios()
    const passed = results.filter((r) => r.passed).length
    return Response.json({
      summary: { total: results.length, passed, failed: results.length - passed },
      results,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof ZatcaForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('integrations.manage', handlePost)
