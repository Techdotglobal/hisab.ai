import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

export interface AuditLogInput {
  action: string
  entityType: string
  entityId?: string | null
  details?: Record<string, unknown> | null
  userId?: string | null
  companyId?: string
  /** Previous / new values of the changed fields. Never put secrets in here. */
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  reason?: string | null
  ipAddress?: string | null
  requestId?: string | null
}

export async function logAudit(input: AuditLogInput): Promise<void> {
  const companyId = input.companyId ?? await resolveCompanyId()
  const client = createAdminClient()

  const { error } = await client.from('audit_logs').insert({
    company_id: companyId,
    user_id: input.userId ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    details: input.details ?? null,
    before_state: input.before ?? null,
    after_state: input.after ?? null,
    reason: input.reason ?? null,
    ip_address: input.ipAddress ?? null,
    request_id: input.requestId ?? null,
  })

  if (error) throw error
}
