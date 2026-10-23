import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-request memoisation for identity lookups (auth user, app user, company, access snapshot).
 *
 * A request opens a scope with `runWithRequestMemo`; every `memoPerRequest(key, load)` inside it shares
 * one result, so a route that checks auth from the proxy-adjacent guard, the handler and helpers pays
 * for one lookup instead of one per call site. Nothing outlives the request, so revoking a grant or
 * membership still applies on the next request. Outside a scope (workers, pages) it just calls `load`.
 */
const scope = new AsyncLocalStorage<Map<string, Promise<unknown>>>()

export function runWithRequestMemo<T>(operation: () => T): T {
  return scope.getStore() ? operation() : scope.run(new Map(), operation)
}

export function memoPerRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const store = scope.getStore()
  if (!store) return load()
  const hit = store.get(key) as Promise<T> | undefined
  if (hit) return hit
  const pending = load()
  store.set(key, pending)
  // A failed lookup is never reused, so a retry inside the same request can succeed.
  pending.catch(() => { if (store.get(key) === pending) store.delete(key) })
  return pending
}
