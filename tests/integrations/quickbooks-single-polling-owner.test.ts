import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

const providerPath = 'src/components/import-export/MigrationSessionProvider.tsx'
const centerPath = 'src/app/(dashboard)/migration-center/[sessionId]/page.tsx'
const centerIndexPath = 'src/app/(dashboard)/migration-center/page.tsx'
const historyPath = 'src/app/(dashboard)/migration-history/page.tsx'
const wizardPagePath = 'src/app/(dashboard)/migration-wizard/page.tsx'
const wizardFlowPath = 'src/components/import-export/steps/ConnectedSourceFlow.tsx'
const centerComponentPath = 'src/components/import-export/MigrationCenter.tsx'

test('MigrationSessionProvider is the only migration polling owner', () => {
  const provider = read(providerPath)
  const children = [
    read(centerPath),
    read(centerIndexPath),
    read(historyPath),
    read(wizardPagePath),
    read(wizardFlowPath),
    read(centerComponentPath),
  ]

  assert.equal(provider.match(/window\.setInterval\(/g)?.length, 1)
  assert.match(provider, /POLL_INTERVAL_MS = 1_500/)
  assert.match(provider, /timer = window\.setInterval\(\(\) => \{[\s\S]*?isPollDue\(\{[\s\S]*?void refresh\(\)/)

  for (const child of children) {
    assert.doesNotMatch(child, /setInterval\(/)
    assert.doesNotMatch(child, /POLL_MS/)
  }
})

test('one provider refresh performs exactly one migration hydration GET', () => {
  const provider = read(providerPath)
  const refresh = provider.slice(
    provider.indexOf('const refresh = useCallback'),
    provider.indexOf('const patchSession = useCallback'),
  )

  assert.equal(refresh.match(/await fetch\(/g)?.length, 1)
  assert.match(refresh, /polledSessionIdRef\.current/)
  assert.match(refresh, /poll: '1'/)
  assert.match(refresh, /\/api\/import-export\/migration-sessions\/\$\{encodeURIComponent\(sessionId\)\}\?\$\{params\}/)
  assert.match(refresh, /\/api\/import-export\/migration-sessions\?\$\{params\}/)
  assert.match(refresh, /includeLatest/)
  assert.match(refresh, /signal: controller\.signal/)
  assert.match(refresh, /sequence !== refreshSequenceRef\.current/)
  assert.match(refresh, /mergeMigrationPollPayload/)
})

test('Migration Center consumes the provider snapshot without hydrating or polling', () => {
  const center = read(centerPath)

  assert.match(center, /useMigrationSession\(\)/)
  assert.match(center, /session: contextSession/)
  assert.match(center, /contextSession\?\.id === sessionId/)
  assert.match(center, /retrySession/)
  assert.match(center, /cancelSession/)
  assert.doesNotMatch(center, /fetch\(/)
  assert.doesNotMatch(center, /setInterval\(/)
  assert.doesNotMatch(center, /setSession\(/)
})

test('Migration History consumes provider-owned cached state without polling', () => {
  const history = read(historyPath)
  const provider = read(providerPath)

  assert.match(history, /const \{ history, loadHistory \} = useMigrationHistory\(\)/)
  assert.match(history, /void loadHistory\(\{ page, limit, status \}\)/)
  assert.doesNotMatch(history, /fetch\(/)
  assert.doesNotMatch(history, /setInterval\(/)

  assert.match(provider, /historyRequestKeyRef\.current === key/)
  assert.match(provider, /historyLoadedKeyRef\.current === key/)
  assert.match(provider, /const MigrationHistoryContext = createContext/)
  assert.match(provider, /const historyValue = useMemo<MigrationHistoryContextValue>/)
  assert.match(provider, /list: 'true'/)
})

test('Wizard consumes provider session restoration and never rehydrates it', () => {
  const page = read(wizardPagePath)
  const flow = read(wizardFlowPath)
  const provider = read(providerPath)

  assert.match(page, /sessionLoading/)
  assert.match(page, /if \(sessionLoading \|\| openedRef\.current\) return/)
  assert.match(flow, /persistentSession: HydratedMigrationSession \| null/)
  assert.match(flow, /onCancelSession: \(sessionId: string\) => Promise<void>/)
  assert.doesNotMatch(flow, /fetch\('\/api\/import-export\/migration-sessions', \{ cache: 'no-store' \}\)/)
  assert.match(provider, /persistentSession=\{session\}/)
  assert.match(provider, /onCancelSession=\{cancelSession\}/)
})

test('route changes select the provider polling target without adding an interval', () => {
  const provider = read(providerPath)

  assert.match(provider, /usePathname\(\)/)
  assert.match(provider, /migrationSessionIdFromPathname\(pathname\)/)
  assert.match(provider, /previousPolledSessionIdRef\.current === polledSessionId/)
  assert.match(provider, /void refresh\(/)
  assert.equal(provider.match(/window\.setInterval\(/g)?.length, 1)
})

test('reopening Center, History, or Wizard cannot create another polling loop', () => {
  const routes = [
    read(centerPath),
    read(centerIndexPath),
    read(historyPath),
    read(wizardPagePath),
  ]
  for (const route of routes) {
    assert.doesNotMatch(route, /setInterval\(/)
    assert.doesNotMatch(route, /clearInterval\(/)
  }

  const provider = read(providerPath)
  assert.equal(provider.match(/window\.setInterval\(/g)?.length, 1)
  assert.match(provider, /window\.clearInterval\(timer\)/)
})

test('unchanged hydration snapshots do not trigger duplicate session state updates', () => {
  const provider = read(providerPath)
  const refresh = provider.slice(
    provider.indexOf('const refresh = useCallback'),
    provider.indexOf('const patchSession = useCallback'),
  )

  assert.match(provider, /function sessionSnapshot\(session: HydratedMigrationSession \| null\)/)
  assert.match(refresh, /if \(snapshot !== sessionSnapshotRef\.current\) \{/)
  assert.equal(refresh.match(/setSession\(nextSession\)/g)?.length, 1)
  assert.match(refresh, /requestScope !== \(polledSessionIdRef\.current \?\? '__latest__'\)/)
})
