import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

export interface AuditQuery {
  companyId: string
  from?: string | null
  to?: string | null
  userId?: string | null
  action?: string | null
  entityType?: string | null
  entityId?: string | null
  /** 'permissions' limits to access-management events; 'financial' to posting/journal/etc. */
  category?: 'permissions' | 'financial' | null
  limit?: number
  offset?: number
}

export interface AuditRow {
  id: string
  createdAt: string
  actorId: string | null
  actorName: string | null
  action: string
  entityType: string
  entityId: string | null
  reason: string | null
  before: unknown
  after: unknown
  details: unknown
  ipAddress: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Maps an audited entity to the screen where the user can open it, if one exists. */
export function auditEntityHref(entityType: string, entityId: string | null): string | null {
  if (!entityId) return null
  switch (entityType) {
    case 'user_access':
      return `/users?user=${entityId}`
    case 'journal_entry':
      return `/journal?id=${entityId}`
    case 'invoice':
      return `/invoices/${entityId}`
    case 'bill':
      return `/bills/${entityId}`
    default:
      return null
  }
}

export async function queryAuditLogs(q: AuditQuery): Promise<{ rows: AuditRow[]; total: number }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500)
  const offset = Math.max(q.offset ?? 0, 0)
  const admin = createAdminClient()
  let query = admin
    .from('audit_logs')
    .select('id, user_id, action, entity_type, entity_id, reason, before_state, after_state, details, ip_address, created_at', { count: 'exact' })
    .eq('company_id', q.companyId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (q.from) query = query.gte('created_at', q.from)
  if (q.to) query = query.lte('created_at', q.to)
  if (q.userId && UUID.test(q.userId)) query = query.eq('user_id', q.userId)
  if (q.action) query = query.eq('action', q.action)
  if (q.entityType) query = query.eq('entity_type', q.entityType)
  if (q.entityId && UUID.test(q.entityId)) query = query.eq('entity_id', q.entityId)
  if (q.category === 'permissions') query = query.eq('entity_type', 'user_access')
  if (q.category === 'financial') {
    query = query.in('entity_type', ['journal_entry', 'invoice', 'bill', 'expense', 'payment', 'fiscal_year'])
  }

  const { data, error, count } = await query
  if (error) throw error

  const ids = [...new Set((data ?? []).map((r) => r.user_id as string | null).filter((i): i is string => Boolean(i)))]
  const names = new Map<string, string>()
  if (ids.length) {
    const { data: profiles } = await admin.from('profiles').select('id, full_name').in('id', ids)
    for (const p of profiles ?? []) names.set(String(p.id), (p.full_name as string | null) ?? '')
  }

  return {
    total: count ?? 0,
    rows: (data ?? []).map((r) => ({
      id: String(r.id),
      createdAt: String(r.created_at),
      actorId: (r.user_id as string | null) ?? null,
      actorName: r.user_id ? names.get(String(r.user_id)) ?? null : null,
      action: String(r.action),
      entityType: String(r.entity_type),
      entityId: (r.entity_id as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      before: r.before_state ?? null,
      after: r.after_state ?? null,
      details: r.details ?? null,
      ipAddress: (r.ip_address as string | null) ?? null,
    })),
  }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

export function auditRowsToCsv(rows: AuditRow[]): string {
  const header = ['Time', 'Actor', 'Action', 'Entity type', 'Entity ID', 'Reason', 'Before', 'After', 'IP']
  const lines = rows.map((r) =>
    [r.createdAt, r.actorName ?? r.actorId, r.action, r.entityType, r.entityId, r.reason, r.before, r.after, r.ipAddress]
      .map(csvCell)
      .join(','),
  )
  return [header.map(csvCell).join(','), ...lines].join('\r\n')
}
