/**
 * Fetches every page of a server-paginated list endpoint, using the same query
 * parameters the on-screen table uses, so exports contain the complete filtered
 * dataset rather than only the visible page.
 */
export async function fetchAllPages<T>(
  endpoint: string,
  params: URLSearchParams,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 100
  const maxPages = opts.maxPages ?? 500
  const all: T[] = []
  let page = 1
  let totalPages = 1
  do {
    const query = new URLSearchParams(params)
    query.set('page', String(page))
    query.set('pageSize', String(pageSize))
    const res = await fetch(`${endpoint}?${query}`)
    if (!res.ok) {
      let message = `Request failed (${res.status})`
      try { const body = await res.json(); if (body?.error) message = String(body.error) } catch { /* keep default */ }
      throw new Error(message)
    }
    const payload = await res.json() as { items: T[]; totalPages?: number }
    all.push(...payload.items)
    totalPages = payload.totalPages ?? 1
    page += 1
  } while (page <= totalPages && page <= maxPages)
  return all
}
