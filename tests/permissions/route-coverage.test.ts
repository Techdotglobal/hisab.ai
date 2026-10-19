import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, it } from 'node:test'
// @ts-expect-error plain .mjs policy shared with the codemod
import { EXEMPT, resolvePolicy } from '../../scripts/rbac/route-policy.mjs'
import { ALL_PERMISSIONS } from '../../src/lib/permissions/catalog'

const API_ROOT = join(process.cwd(), 'src', 'app', 'api')
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : f === 'route.ts' ? [p] : []
  })
}
const routes = walk(API_ROOT).map((file) => ({
  file,
  path: relative(API_ROOT, file).split(sep).slice(0, -1).join('/'),
  src: readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
}))

// Handlers that sit behind the integration middleware, which itself calls requirePermission().
const INTEGRATION_WRAPPED = [
  'integrations',
  'integrations/quickbooks/analyze',
  'integrations/quickbooks/connect',
  'integrations/quickbooks/disconnect',
  'integrations/quickbooks/status',
]

describe('API authorization coverage', () => {
  it('found the API routes', () => {
    assert.ok(routes.length > 200)
  })

  it('every exported HTTP handler is wrapped in guarded(), exempt-with-reason, or integration-wrapped', () => {
    const offenders: string[] = []
    for (const r of routes) {
      if (r.path in EXEMPT || INTEGRATION_WRAPPED.includes(r.path)) continue
      for (const m of METHODS) {
        if (new RegExp(`^export async function ${m}\\(`, 'm').test(r.src)) offenders.push(`${r.path} ${m} (unwrapped function)`)
        const exported = new RegExp(`^export (const|\\{)[^\\n]*\\b${m}\\b`, 'm').test(r.src)
        if (exported && !new RegExp(`^export const ${m} = guarded\\(`, 'm').test(r.src)) offenders.push(`${r.path} ${m}`)
      }
    }
    assert.deepEqual(offenders, [])
  })

  it('guarded permissions match the central policy table', () => {
    const mismatches: string[] = []
    for (const r of routes) {
      for (const m of METHODS) {
        const found = new RegExp(`^export const ${m} = guarded\\((.+), handle\\w+\\)`, 'm').exec(r.src)
        if (!found) continue
        const expected = resolvePolicy(r.path, m)
        const fmt = Array.isArray(expected) ? `[${expected.map((p: string) => `'${p}'`).join(', ')}]` : `'${expected}'`
        if (found[1] !== fmt) mismatches.push(`${r.path} ${m}: ${found[1]} != ${fmt}`)
      }
    }
    assert.deepEqual(mismatches, [])
  })

  it('every permission referenced by the policy exists in the catalog', () => {
    const known = new Set<string>(ALL_PERMISSIONS)
    const used = new Set<string>()
    for (const r of routes) for (const m of METHODS) {
      const p = resolvePolicy(r.path, m)
      if (p) for (const k of Array.isArray(p) ? p : [p]) used.add(k)
    }
    assert.deepEqual([...used].filter((k) => !known.has(k)), [])
  })

  it('exempt routes are either intentionally public or perform their own permission check', () => {
    const publicRoutes = new Set([
      'auth/logout', 'auth/register', 'auth/me', 'health', 'live', 'ready',
      'integrations/quickbooks/callback', 'integrations/quickbooks/webhook',
    ])
    for (const r of routes) {
      if (!(r.path in EXEMPT) || publicRoutes.has(r.path)) continue
      assert.match(r.src, /requirePermission|requireAnyPermission|requireRole\(\['OWNER'\]\)/, `${r.path} must check permissions itself`)
    }
  })

  it('protected admin endpoints never trust identifiers from the request body for the company', () => {
    for (const r of routes.filter((x) => x.path.startsWith('users') || x.path === 'roles' || x.path === 'audit-logs')) {
      assert.doesNotMatch(r.src, /body\.companyId|searchParams\.get\('companyId'\)/, r.path)
    }
  })

  it('the QA seed endpoint is permission-guarded and disabled outside development unless explicitly enabled', () => {
    const seed = routes.find((r) => r.path === 'seed')!
    assert.match(seed.src, /guarded\('settings\.manage'/)
    assert.match(seed.src, /ENABLE_QA_SEED/)
  })
})
