import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ALL_PERMISSIONS } from '../../src/lib/permissions/catalog'
import { importPermissionsFor, mappedImportModules } from '../../src/lib/import-export/module-permissions'

describe('import module permissions', () => {
  const catalog = readFileSync('src/lib/import-export/registry/module-catalog.ts', 'utf8')
  const keys = [...catalog.matchAll(/key: '([^']+)'/g)].map((m) => m[1])

  it('every registered import module has an explicit write permission', () => {
    assert.ok(keys.length > 30)
    assert.deepEqual(keys.filter((k) => !mappedImportModules().includes(k)), [])
  })
  it('requires imports.run plus the module permission, all valid catalog keys', () => {
    assert.deepEqual(importPermissionsFor('invoices'), ['imports.run', 'invoices.edit'])
    assert.deepEqual(importPermissionsFor('journal-entries'), ['imports.run', 'journals.edit'])
    for (const k of keys) for (const p of importPermissionsFor(k)) assert.ok((ALL_PERMISSIONS as string[]).includes(p), `${k} -> ${p}`)
  })
  it('unknown modules fail closed', () => {
    assert.deepEqual(importPermissionsFor('nope'), ['imports.run', 'settings.manage'])
  })
  it('the import route enforces it for interactive callers', () => {
    const route = readFileSync('src/app/api/import-export/[module]/import/route.ts', 'utf8')
    assert.match(route, /requirePermission\(\.\.\.importPermissionsFor\(resolvedModule\)\)/)
  })
})
