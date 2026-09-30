import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function supabaseDb(client?: SupabaseClient): SupabaseClient {
  return client ?? createAdminClient()
}

export { resolveCompanyId, resolveCompanyIdOrThrow, TenantAccessError } from '@/lib/tenant'

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return parseFloat(value) || 0
  return 0
}

export function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  return new Date(value)
}

export function requireDate(value: string): Date {
  return new Date(value)
}

/** Lookup by UUID primary key or Phase C `legacy_id` (SQLite cuid). */
export async function queryByIdOrLegacy(
  client: SupabaseClient,
  table: string,
  id: string,
  companyId: string,
): Promise<Record<string, unknown> | null> {
  const base = client.from(table).select('*').eq('company_id', companyId).is('deleted_at', null)

  if (isUuid(id)) {
    const { data, error } = await base.eq('id', id).maybeSingle()
    if (error) throw error
    return data
  }

  const { data, error } = await base.eq('legacy_id', id).maybeSingle()
  if (error) throw error
  return data
}

export function ilikeFilter(column: string, search: string): string {
  return `${column}.ilike.%${search.replace(/[%_]/g, '\\$&')}%`
}

interface RangeableQuery<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

/**
 * Fetch every row matching a query, paging past PostgREST's own server-side max-rows cap
 * (commonly 1000) instead of silently truncating. `factory` must build a *fresh* filtered
 * query each call (not a query with `.range()` already applied) — this calls it once per
 * page with an increasing offset. Used anywhere a full table scan feeds an in-memory count
 * or sum (e.g. dashboard aggregates), where a truncated result isn't just an incomplete
 * list — it's a wrong number reported as the real total.
 */
export async function fetchAllRows<T = Record<string, unknown>>(
  factory: () => RangeableQuery<T>,
  pageSize = 1000,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await factory().range(offset, offset + pageSize - 1)
    if (error) return { data: rows, error }
    rows.push(...(data ?? []))
    if (!data || data.length < pageSize) break
    offset += data.length
  }
  return { data: rows, error: null }
}
