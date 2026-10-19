// One-off codemod: wraps every exported HTTP handler in src/app/api/**/route.ts with guarded(permission, handler)
// according to scripts/rbac/route-policy.mjs. Idempotent (skips already-guarded handlers).
// Usage: node scripts/rbac/apply-route-guards.mjs [--dry]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { EXEMPT, resolvePolicy } from './route-policy.mjs'

const root = join(process.cwd(), 'src', 'app', 'api')
const dry = process.argv.includes('--dry')
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : f === 'route.ts' ? [p] : []
  })
}

const fmt = (perm) => (Array.isArray(perm) ? `[${perm.map((p) => `'${p}'`).join(', ')}]` : `'${perm}'`)
let changed = 0
const problems = []

for (const file of walk(root)) {
  const routePath = relative(root, file).split(sep).slice(0, -1).join('/')
  if (routePath in EXEMPT) continue
  let src = readFileSync(file, 'utf8')
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  let exportsToAdd = []
  for (const method of METHODS) {
    const re = new RegExp('^export async function ' + method + '[(]', 'm')
    if (!re.test(src)) continue
    const perm = resolvePolicy(routePath, method)
    if (!perm) {
      problems.push(`${routePath} ${method}: no policy`)
      continue
    }
    const impl = `handle${method[0]}${method.slice(1).toLowerCase()}`
    src = src.replace(re, `async function ${impl}(`)
    exportsToAdd.push(`export const ${method} = guarded(${fmt(perm)}, ${impl})`)
  }
  if (!exportsToAdd.length) continue
  const importLine = "import { guarded } from '@/lib/permissions/guard'"
  const firstImport = src.search(/^import /m)
  src = firstImport >= 0 ? src.slice(0, firstImport) + importLine + eol + src.slice(firstImport) : importLine + eol + src
  src = src.replace(/\s*$/, '') + eol + eol + exportsToAdd.join(eol) + eol
  changed++
  if (!dry) writeFileSync(file, src)
}
console.log(`${dry ? '[dry] ' : ''}guarded ${changed} route files`)
if (problems.length) {
  console.log('UNMAPPED:\n' + problems.join('\n'))
  process.exitCode = 1
}
