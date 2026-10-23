import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { memoPerRequest, runWithRequestMemo } from '../../src/lib/request-memo'

test('lookups inside one request scope run once; each request starts clean', async () => {
  let calls = 0
  const load = async () => ++calls
  const first = await runWithRequestMemo(async () => [await memoPerRequest('k', load), await memoPerRequest('k', load)])
  assert.deepEqual(first, [1, 1])
  const second = await runWithRequestMemo(() => memoPerRequest('k', load))
  assert.equal(second, 2, 'a new request never sees the previous request’s result')
})

test('concurrent callers share one in-flight lookup, and different keys stay separate', async () => {
  let calls = 0
  const load = async () => { const id = ++calls; await new Promise((r) => setTimeout(r, 5)); return id }
  await runWithRequestMemo(async () => {
    const [a, b, other] = await Promise.all([memoPerRequest('a', load), memoPerRequest('a', load), memoPerRequest('b', load)])
    assert.equal(a, b)
    assert.notEqual(a, other)
  })
  assert.equal(calls, 2)
})

test('failures are not cached and outside a scope nothing is memoised', async () => {
  let calls = 0
  await runWithRequestMemo(async () => {
    await assert.rejects(memoPerRequest('f', async () => { calls++; throw new Error('boom') }))
    assert.equal(await memoPerRequest('f', async () => { calls++; return 'ok' }), 'ok')
  })
  assert.equal(calls, 2)
  let outside = 0
  await memoPerRequest('x', async () => ++outside)
  await memoPerRequest('x', async () => ++outside)
  assert.equal(outside, 2)
})

test('identity lookups share the request scope; the guard opens it; target reads stay fresh', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  assert.match(read('src/lib/permissions/guard.ts'), /runWithRequestMemo\(async/)
  assert.match(read('src/lib/auth.ts'), /memoPerRequest\('auth\.user'/)
  assert.match(read('src/lib/auth.ts'), /memoPerRequest\('auth\.session'/)
  assert.match(read('src/lib/tenant.ts'), /memoPerRequest\('tenant\.companyId'/)
  const server = read('src/lib/permissions/server.ts')
  assert.equal(server.match(/loadCallerSnapshot\(user\.id, companyId\)/g)?.length, 2)
  assert.match(read('src/lib/permissions/service.ts'), /await loadAccessSnapshot\(userId, ctx\.companyId\)/)
  const layout = read('src/app/(dashboard)/layout.tsx')
  assert.match(layout, /NOTIFICATION_COUNT_TTL_MS/)
  assert.doesNotMatch(layout, /notifications\?count=true'\)[\s\S]{0,200}\}, \[pathname\]\)/)
})
