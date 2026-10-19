import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { resolveCompanyId, supabaseDb } from '@/lib/db/repository-utils'

async function handleGet() {
  try {
    await requireAuth()
    const db = supabaseDb()
    const companyId = await resolveCompanyId()

    const { data, error } = await db
      .from('zatca_api_logs')
      .select('id, endpoint, response_code, success, duration_ms, request_id, global_transaction_id, created_at, metadata')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw error

    const logs = (data ?? []).map((row) => ({
      id: String(row.id),
      endpoint: String(row.endpoint),
      httpCode: String(row.response_code),
      success: Boolean(row.success),
      durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
      correlationId: (row.metadata as { correlationId?: string } | null)?.correlationId ?? null,
      globalTransactionId: (row.global_transaction_id as string | null) ?? null,
      requestId: (row.request_id as string | null) ?? null,
      timestamp: String(row.created_at),
    }))

    return Response.json(logs)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
