'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { readApiError } from '@/lib/api-client'
import {
  activeModule,
  applyJobCreated,
  deriveOverallProgress,
  migrationHasStarted,
} from '@/lib/import-export/wizard/module-lifecycle'
import {
  coordinationFingerprint,
  isReplayableCoordinationAction,
  nextCoordinationAction,
} from '@/lib/import-export/wizard/migration-coordination'
import { migrationCenterPath } from '@/lib/import-export/wizard/migration-center-view'
import {
  navigationTarget,
  resolveNavigation,
} from '@/lib/import-export/wizard/migration-navigation'
import {
  IndicatorAutoCollapseController,
  initialIndicatorPresentation,
  PANEL_EXIT_MS,
  presentationAfterCollapseRequest,
  presentationAfterExitAnimation,
  presentationAfterExpand,
  presentationForSessionTransition,
  resolveIndicatorCollapseDelayMs,
  type IndicatorPresentation,
} from '@/lib/import-export/wizard/migration-indicator-state'
import {
  extractActivityCursors,
  mergeMigrationPollPayload,
  migrationPollLiveFingerprint,
  type MigrationPollEnvelope,
} from '@/lib/import-export/wizard/migration-poll-payload'
import {
  canPaintCachedMigrationSession,
  createMigrationRestoreTimer,
  formatMigrationRestoreBreakdown,
  shouldDeferActivityOnRestore,
} from '@/lib/import-export/wizard/migration-restore-timing'
import type {
  HydratedMigrationSession,
  MigrationHistorySummary,
  MigrationSessionState,
} from '@/lib/import-export/wizard/migration-session'
import { isWorkerOwnedQuickBooksMigration } from '@/lib/import-export/wizard/migration-session'
import { isPollDue } from '@/lib/import-export/wizard/migration-poll-schedule'
import { ConnectedSourceFlow } from './steps/ConnectedSourceFlow'

/** Local tick; the real fetch cadence comes from migration-poll-schedule. */
const POLL_INTERVAL_MS = 1_500
/** Releases a navigation latch whose transition never committed, so retries stay possible. */
const NAVIGATION_LATCH_MS = 5_000
/** Browser-tab memory only — cleared on full reload. */
const dismissedIndicatorSessionIds = new Set<string>()
const expandedTerminalSessionIds = new Set<string>()

function currentNavigationTarget(): string {
  if (typeof window === 'undefined') return ''
  return navigationTarget(window.location)
}

interface MigrationSessionContextValue {
  session: HydratedMigrationSession | null
  sessionLoading: boolean
  sessionError: string | null
  viewerOpen: boolean
  /** Opens configuration wizard only. Running migrations open Migration Center. */
  openViewer: () => void
  closeViewer: () => void
  openMigrationCenter: (sessionId?: string) => void
  refresh: () => Promise<void>
  retrySession: (sessionId: string) => Promise<void>
  cancelSession: (sessionId: string) => Promise<void>
}

interface MigrationHistoryContextValue {
  history: MigrationHistoryState
  loadHistory: (query: MigrationHistoryQuery) => Promise<void>
}

interface MigrationHistoryQuery {
  page: number
  limit: number
  status: MigrationSessionState | ''
}

interface MigrationHistoryState {
  items: MigrationHistorySummary[]
  total: number
  page: number
  limit: number
  status: MigrationSessionState | ''
  loading: boolean
  error: string | null
}

const EMPTY_HISTORY: MigrationHistoryState = {
  items: [],
  total: 0,
  page: 1,
  limit: 25,
  status: '',
  loading: false,
  error: null,
}

function migrationSessionIdFromPathname(pathname: string): string | null {
  const match = /^\/migration-center\/([^/]+)\/?$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : null
}

function sessionSnapshot(session: HydratedMigrationSession | null): string {
  return JSON.stringify(session)
}

const MigrationSessionContext = createContext<MigrationSessionContextValue | null>(null)
const MigrationHistoryContext = createContext<MigrationHistoryContextValue | null>(null)

export function useMigrationSession() {
  const value = useContext(MigrationSessionContext)
  if (!value) throw new Error('useMigrationSession must be used inside MigrationSessionProvider')
  return value
}

export function useMigrationHistory() {
  const value = useContext(MigrationHistoryContext)
  if (!value) throw new Error('useMigrationHistory must be used inside MigrationSessionProvider')
  return value
}

export function MigrationSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const polledSessionId = migrationSessionIdFromPathname(pathname)
  const pollScope = polledSessionId ?? '__latest__'
  const [session, setSession] = useState<HydratedMigrationSession | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [hydratedScope, setHydratedScope] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [history, setHistory] = useState<MigrationHistoryState>(EMPTY_HISTORY)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Bumped only by explicit lifecycle events or a failed cycle, never by a poll. */
  const [coordinationAttempt, setCoordinationAttempt] = useState(0)
  const sessionRef = useRef<HydratedMigrationSession | null>(null)
  const sessionSnapshotRef = useRef('')
  const liveFingerprintRef = useRef<string | null>(null)
  const hasStaticRef = useRef(false)
  const polledSessionIdRef = useRef<string | null>(polledSessionId)
  const previousPolledSessionIdRef = useRef<string | null>(polledSessionId)
  polledSessionIdRef.current = polledSessionId
  const coordinatingRef = useRef(false)
  const coordinatedSignalRef = useRef<string | null>(null)
  const pendingSignalRef = useRef<string | null>(null)
  const issuedActionsRef = useRef<Set<string>>(new Set())
  const coordinationFailedRef = useRef(false)
  const refreshControllerRef = useRef<AbortController | null>(null)
  const refreshSequenceRef = useRef(0)
  const historyControllerRef = useRef<AbortController | null>(null)
  const historyRequestKeyRef = useRef<string | null>(null)
  const historyLoadedKeyRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  const pendingNavigationRef = useRef<string | null>(null)
  const navigationTimerRef = useRef<number | null>(null)
  /** Tracks whether the current scope still needs a lean (activity-deferred) first poll. */
  const pendingLeanActivityRef = useRef(true)
  const activityHydratedRef = useRef(false)
  const restoreTimerRef = useRef(createMigrationRestoreTimer())

  const releaseNavigationLatch = useCallback(() => {
    if (navigationTimerRef.current !== null) {
      window.clearTimeout(navigationTimerRef.current)
      navigationTimerRef.current = null
    }
    pendingNavigationRef.current = null
  }, [])

  /** Drops the latch as soon as the pending transition is observed as committed. */
  const syncNavigationLatch = useCallback(() => {
    const pending = pendingNavigationRef.current
    if (pending && currentNavigationTarget() === pending) releaseNavigationLatch()
  }, [releaseNavigationLatch])

  /**
   * The only place this provider pushes a route. Repeated requests for a target
   * that is already pending or already rendered are dropped, so polling-driven
   * re-renders can neither duplicate nor restart a transition.
   */
  const navigateOnce = useCallback((target: string) => {
    syncNavigationLatch()
    const decision = resolveNavigation({
      target,
      currentTarget: currentNavigationTarget(),
      pendingTarget: pendingNavigationRef.current,
    })
    if (decision === 'transition-pending') return
    if (decision === 'already-there') {
      releaseNavigationLatch()
      return
    }
    releaseNavigationLatch()
    pendingNavigationRef.current = target
    navigationTimerRef.current = window.setTimeout(() => {
      navigationTimerRef.current = null
      pendingNavigationRef.current = null
    }, NAVIGATION_LATCH_MS)
    router.push(target)
  }, [releaseNavigationLatch, router, syncNavigationLatch])

  const openMigrationCenter = useCallback((sessionId?: string) => {
    const id = sessionId ?? sessionRef.current?.id
    if (!id) return
    setViewerOpen(false)
    navigateOnce(migrationCenterPath(id))
  }, [navigateOnce])

  // Reads the session from a ref so the callback identity survives every poll:
  // consumers that depend on it must not re-run once per refresh.
  const openViewer = useCallback(() => {
    syncNavigationLatch()
    // A pending Migration Center transition must never be interrupted or restarted.
    if (pendingNavigationRef.current) return
    const current = sessionRef.current
    if (current && (current.config.state === 'running' || migrationHasStarted(current.lifecycle))) {
      openMigrationCenter(current.id)
      return
    }
    if (current && (current.config.state === 'completed' || current.config.state === 'failed' || current.config.state === 'cancelled')) {
      openMigrationCenter(current.id)
      return
    }
    setViewerOpen(true)
  }, [openMigrationCenter, syncNavigationLatch])

  const closeViewer = useCallback(() => setViewerOpen(false), [])

  const refresh = useCallback(async (options: { deferActivity?: boolean } = {}) => {
    refreshControllerRef.current?.abort()
    const controller = new AbortController()
    refreshControllerRef.current = controller
    const sequence = ++refreshSequenceRef.current
    const sessionId = polledSessionIdRef.current
    const requestScope = sessionId ?? '__latest__'
    const needStatic = !hasStaticRef.current
      || !sessionRef.current
      || (sessionId != null && sessionRef.current.id !== sessionId)
    const hasCachedActivity = activityHydratedRef.current
      || Object.values(sessionRef.current?.jobs ?? {}).some(
        (job) => (job.activityEvents?.length ?? 0) > 0,
      )
    const deferActivity = options.deferActivity
      ?? shouldDeferActivityOnRestore({
        isInitialScopeHydrate: pendingLeanActivityRef.current,
        hasCachedActivity,
      })
    let nextSession: HydratedMigrationSession | null = null
    const timer = restoreTimerRef.current
    timer.begin('client_fetch')
    try {
      const params = new URLSearchParams({ poll: '1' })
      if (!sessionId) params.set('includeLatest', 'true')
      if (!needStatic) params.set('static', '0')
      if (deferActivity) params.set('activity', '0')
      const endpoint = sessionId
        ? `/api/import-export/migration-sessions/${encodeURIComponent(sessionId)}?${params}`
        : `/api/import-export/migration-sessions?${params}`
      const headers: Record<string, string> = {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      }
      const cursors = deferActivity ? {} : extractActivityCursors(sessionRef.current)
      if (Object.keys(cursors).length > 0) {
        headers['x-migration-activity-cursors'] = JSON.stringify(cursors)
      }
      if (liveFingerprintRef.current && !deferActivity) {
        headers['x-migration-live-fingerprint'] = liveFingerprintRef.current
      }
      const response = await fetch(endpoint, {
        cache: 'no-store',
        headers,
        signal: controller.signal,
      })
      if (response.status === 404) {
        timer.end('client_fetch')
        nextSession = null
        hasStaticRef.current = false
        liveFingerprintRef.current = null
        activityHydratedRef.current = false
      } else {
        if (!response.ok) throw new Error(await readApiError(response))
        const payload = await response.json() as {
          poll?: MigrationPollEnvelope | null
          session?: HydratedMigrationSession | null
        }
        timer.end('client_fetch')
        timer.begin('client_merge')
        if (payload.poll) {
          if (payload.poll.kind === 'noop') {
            nextSession = sessionRef.current
          } else {
            nextSession = mergeMigrationPollPayload(sessionRef.current, payload.poll)
            if (payload.poll.static) hasStaticRef.current = true
            if (!deferActivity) activityHydratedRef.current = true
          }
        } else if (payload.poll === null) {
          nextSession = null
          hasStaticRef.current = false
          liveFingerprintRef.current = null
          activityHydratedRef.current = false
        } else {
          // Backward-compatible full session responses (create/retry/patch callers).
          nextSession = payload.session ?? null
          hasStaticRef.current = Boolean(nextSession)
          activityHydratedRef.current = Boolean(nextSession)
        }
        timer.end('client_merge')
      }
    } catch (error) {
      timer.end('client_fetch')
      if (controller.signal.aborted) return
      throw error
    } finally {
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null
    }
    // A superseded response can never overwrite newer session state.
    if (
      !mountedRef.current
      || sequence !== refreshSequenceRef.current
      || requestScope !== (polledSessionIdRef.current ?? '__latest__')
    ) return
    const snapshot = sessionSnapshot(nextSession)
    if (snapshot !== sessionSnapshotRef.current) {
      sessionSnapshotRef.current = snapshot
      historyLoadedKeyRef.current = null
      sessionRef.current = nextSession
      liveFingerprintRef.current = migrationPollLiveFingerprint(nextSession)
      setSession(nextSession)
    }
    setSessionError(nextSession ? null : polledSessionIdRef.current ? 'Migration session not found' : null)
    setHydratedScope(requestScope)
    setSessionLoading(false)
    pendingLeanActivityRef.current = false
    if (deferActivity && nextSession) {
      // Follow-up loads timeline/activity after the core Center can paint.
      // Await so interval polling starts only after restore completes.
      await refresh({ deferActivity: false })
    } else if (typeof window !== 'undefined' && sessionId) {
      const report = timer.finalize()
      console.info(`[migration-restore] ${formatMigrationRestoreBreakdown(report)}`)
      restoreTimerRef.current = createMigrationRestoreTimer()
    }
  }, [])

  const patchSession = useCallback(async (
    sessionId: string,
    body: Record<string, unknown>,
  ) => {
    const response = await fetch(`/api/import-export/migration-sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(await readApiError(response))
  }, [])

  const loadHistory = useCallback(async (query: MigrationHistoryQuery) => {
    const key = `${query.page}:${query.limit}:${query.status}`
    if (historyRequestKeyRef.current === key || historyLoadedKeyRef.current === key) return
    historyControllerRef.current?.abort()
    const controller = new AbortController()
    historyControllerRef.current = controller
    historyRequestKeyRef.current = key
    setHistory((current) => ({
      ...current,
      page: query.page,
      limit: query.limit,
      status: query.status,
      loading: true,
      error: null,
    }))
    try {
      const params = new URLSearchParams({
        list: 'true',
        page: String(query.page),
        limit: String(query.limit),
      })
      if (query.status) params.set('status', query.status)
      const response = await fetch(`/api/import-export/migration-sessions?${params}`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(await readApiError(response))
      const payload = await response.json() as { items: MigrationHistorySummary[]; total: number }
      if (!mountedRef.current || historyRequestKeyRef.current !== key) return
      historyLoadedKeyRef.current = key
      setHistory({
        items: payload.items ?? [],
        total: payload.total ?? 0,
        page: query.page,
        limit: query.limit,
        status: query.status,
        loading: false,
        error: null,
      })
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return
      setHistory((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'Unable to load migration history.',
      }))
    } finally {
      if (historyControllerRef.current === controller) historyControllerRef.current = null
      if (historyRequestKeyRef.current === key) historyRequestKeyRef.current = null
    }
  }, [])

  const forceCoordinationCycle = useCallback(() => {
    coordinatedSignalRef.current = null
    issuedActionsRef.current.clear()
    hasStaticRef.current = false
    liveFingerprintRef.current = null
    setCoordinationAttempt((attempt) => attempt + 1)
  }, [])

  const retrySession = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/import-export/migration-sessions/${sessionId}/retry`, {
      method: 'POST',
    })
    if (!response.ok) throw new Error(await readApiError(response))
    forceCoordinationCycle()
    await refresh()
  }, [forceCoordinationCycle, refresh])

  const cancelSession = useCallback(async (sessionId: string) => {
    const response = await fetch(`/api/import-export/migration-sessions/${sessionId}/cancel`, {
      method: 'POST',
    })
    if (!response.ok) throw new Error(await readApiError(response))
    await refresh()
  }, [refresh])

  /**
   * Runs at most one side effect per meaningful lifecycle change. The signal is a
   * content fingerprint, so an unchanged poll response is a no-op and the
   * refresh issued after a mutation cannot feed itself another cycle.
   */
  const coordinate = useCallback(async (signal: string) => {
    if (coordinatingRef.current) {
      // Exactly one cycle may exist; a change seen mid-cycle is re-evaluated once.
      pendingSignalRef.current = signal
      return
    }
    if (coordinatedSignalRef.current === signal) return
    const current = sessionRef.current
    if (!current || current.config.state !== 'running') return
    // Current Migrate All sessions are advanced only by the worker. Sessions
    // without this marker are historical browser-coordinated migrations and
    // retain the legacy recovery path.
    if (isWorkerOwnedQuickBooksMigration(current.config)) return

    const action = nextCoordinationAction(current, issuedActionsRef.current)
    coordinatedSignalRef.current = signal
    if (action.type === 'idle') {
      coordinationFailedRef.current = false
      return
    }

    coordinatingRef.current = true
    issuedActionsRef.current.add(action.key)
    const replayableKey = isReplayableCoordinationAction(action) ? action.key : null
    try {
      if (action.type === 'mark-failed') {
        await patchSession(current.id, {
          lifecycle: current.lifecycle,
          step: 'import',
          state: 'failed',
        })
        await refresh()
      } else if (action.type === 'mark-completed') {
        await patchSession(current.id, {
          lifecycle: current.lifecycle,
          step: 'report',
          state: 'completed',
        })
        await refresh()
      } else if (action.type === 'create-job') {
        const unfinished = action.module
        const response = await fetch(`/api/import-export/${unfinished.moduleKey}/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            background: true,
            sourceKey: current.config.provider,
            resourceKey: unfinished.key,
            filename: `${current.config.sourceLabel ?? 'QuickBooks'} - ${unfinished.label}`,
            fileFormat: 'csv',
            duplicateStrategy: current.config.duplicateStrategy,
          }),
        })
        if (!response.ok) throw new Error(await readApiError(response))
        const created = await response.json() as { jobId?: string }
        if (!created.jobId) throw new Error(`${unfinished.label}: migration job did not return an identifier`)
        const lifecycle = applyJobCreated(current.lifecycle, unfinished.key, created.jobId)
        await patchSession(current.id, { lifecycle, step: 'import', state: 'running' })
        await refresh()
      } else {
        const unfinished = action.module
        const response = await fetch(`/api/import-export/jobs/${unfinished.jobId}/run`, {
          method: 'POST',
        })
        if (!response.ok) throw new Error(await readApiError(response))
      }
      coordinationFailedRef.current = false
    } catch (error) {
      // Only idempotent dispatches may be replayed; a created import never is.
      coordinationFailedRef.current = true
      coordinatedSignalRef.current = null
      if (replayableKey) issuedActionsRef.current.delete(replayableKey)
      throw error
    } finally {
      coordinatingRef.current = false
      const dropped = pendingSignalRef.current
      pendingSignalRef.current = null
      if (dropped && dropped !== coordinatedSignalRef.current) {
        setCoordinationAttempt((attempt) => attempt + 1)
      }
    }
  }, [patchSession, refresh])

  useEffect(() => {
    mountedRef.current = true
    restoreTimerRef.current = createMigrationRestoreTimer()
    restoreTimerRef.current.mark('route_mount')
    let timer: number | null = null
    let lastPollAt = Date.now()
    // Interval starts only after the first hydrate so restore is not racing a second poll.
    void refresh().then(() => {
      if (!mountedRef.current) return
      lastPollAt = Date.now()
      // The tick is a cheap local check; the network is only hit when the cadence says it is due
      // (fast while a migration runs in a visible tab, slow when idle, paused in hidden tabs).
      timer = window.setInterval(() => {
        const now = Date.now()
        if (!isPollDue({
          sessionState: sessionRef.current?.config.state,
          hidden: document.visibilityState === 'hidden',
          now,
          lastPollAt,
        })) return
        lastPollAt = now
        void refresh().catch(() => undefined)
        // A failed cycle is retried once per poll tick, never in a tight loop.
        if (coordinationFailedRef.current) setCoordinationAttempt((attempt) => attempt + 1)
      }, POLL_INTERVAL_MS)
    }).catch((error) => {
      if (!mountedRef.current) return
      const message = error instanceof Error ? error.message : 'Unable to load migration status.'
      setActionError(message)
      setSessionError(message)
      setSessionLoading(false)
    })
    const handleSessionChanged = () => {
      forceCoordinationCycle()
      pendingLeanActivityRef.current = false
      void refresh({ deferActivity: false }).catch(() => undefined)
    }
    window.addEventListener('quickbooks-migration-session-changed', handleSessionChanged)
    // A tab returning to the foreground catches up immediately instead of waiting for the next due tick.
    const handleVisible = () => {
      if (document.visibilityState !== 'visible' || timer === null) return
      lastPollAt = Date.now()
      void refresh().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', handleVisible)
    return () => {
      mountedRef.current = false
      document.removeEventListener('visibilitychange', handleVisible)
      if (timer !== null) window.clearInterval(timer)
      releaseNavigationLatch()
      refreshControllerRef.current?.abort()
      historyControllerRef.current?.abort()
      window.removeEventListener('quickbooks-migration-session-changed', handleSessionChanged)
    }
  }, [forceCoordinationCycle, refresh, releaseNavigationLatch])

  useEffect(() => {
    if (previousPolledSessionIdRef.current === polledSessionId) return
    previousPolledSessionIdRef.current = polledSessionId
    restoreTimerRef.current = createMigrationRestoreTimer()
    restoreTimerRef.current.mark('route_mount')

    // Paint immediately from cache when navigating into a session we already hold.
    if (
      canPaintCachedMigrationSession({
        routeSessionId: polledSessionId ?? '',
        cachedSessionId: sessionRef.current?.id,
      })
    ) {
      hasStaticRef.current = true
      pendingLeanActivityRef.current = false
      setHydratedScope(polledSessionId)
      setSessionLoading(false)
      void refresh({ deferActivity: !activityHydratedRef.current }).catch((error) => {
        if (!mountedRef.current) return
        setSessionError(error instanceof Error ? error.message : 'Unable to restore migration session.')
        setSessionLoading(false)
      })
      return
    }

    hasStaticRef.current = false
    liveFingerprintRef.current = null
    activityHydratedRef.current = false
    pendingLeanActivityRef.current = true
    void refresh().catch((error) => {
      if (!mountedRef.current) return
      setSessionError(error instanceof Error ? error.message : 'Unable to restore migration session.')
      setSessionLoading(false)
    })
  }, [polledSessionId, refresh])

  const coordinationSignal = useMemo(() => coordinationFingerprint(session), [session])

  useEffect(() => {
    if (!coordinationSignal) return
    void coordinate(coordinationSignal)
      .catch((error) => setActionError(error instanceof Error ? error.message : 'Migration coordination failed.'))
  }, [coordinate, coordinationAttempt, coordinationSignal])

  const retry = useCallback(async () => {
    if (!session) return
    setActionError(null)
    try {
      await retrySession(session.id)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to retry migration.')
      return
    }
    openMigrationCenter(session.id)
  }, [openMigrationCenter, retrySession, session])

  const handleWizardSuccess = useCallback((createdSessionId?: string) => {
    forceCoordinationCycle()
    void refresh({ deferActivity: false })
    if (createdSessionId) {
      setViewerOpen(false)
      navigateOnce(migrationCenterPath(createdSessionId))
    }
  }, [forceCoordinationCycle, navigateOnce, refresh])

  const cachedMatchesRoute = canPaintCachedMigrationSession({
    routeSessionId: polledSessionId ?? '',
    cachedSessionId: session?.id,
  })
  const value = useMemo<MigrationSessionContextValue>(() => ({
    session,
    // Do not block Center paint when the matching session is already in memory.
    sessionLoading: sessionLoading || (hydratedScope !== pollScope && !cachedMatchesRoute),
    sessionError,
    viewerOpen,
    openViewer,
    closeViewer,
    openMigrationCenter,
    refresh: () => refresh({ deferActivity: false }),
    retrySession,
    cancelSession,
  }), [
    cachedMatchesRoute,
    cancelSession,
    closeViewer,
    hydratedScope,
    openMigrationCenter,
    openViewer,
    refresh,
    retrySession,
    session,
    sessionError,
    sessionLoading,
    pollScope,
    viewerOpen,
  ])
  const historyValue = useMemo<MigrationHistoryContextValue>(() => ({
    history,
    loadHistory,
  }), [history, loadHistory])

  return (
    <MigrationSessionContext.Provider value={value}>
      <MigrationHistoryContext.Provider value={historyValue}>
        {children}
        {session && session.config.state !== 'cancelled' && (
          <MigrationIndicator
            session={session}
            error={actionError}
            onOpen={() => openMigrationCenter(session.id)}
            onRetry={() => void retry()}
            onLogs={() => navigateOnce(`${migrationCenterPath(session.id)}#logs`)}
          />
        )}
        <ConnectedSourceFlow
          open={viewerOpen}
          onClose={() => setViewerOpen(false)}
          onSuccess={handleWizardSuccess}
          persistentSession={session}
          onCancelSession={cancelSession}
          initialSource="quickbooks"
        />
      </MigrationHistoryContext.Provider>
    </MigrationSessionContext.Provider>
  )
}

function MigrationIndicator({
  session,
  error,
  onOpen,
  onRetry,
  onLogs,
}: {
  session: HydratedMigrationSession
  error: string | null
  onOpen: () => void
  onRetry: () => void
  onLogs: () => void
}) {
  const overall = deriveOverallProgress(session.lifecycle)
  const current = activeModule(session.lifecycle)
  const state = session.config.state
  const completed = state === 'completed'
  const failed = state === 'failed'
  const running = state === 'running'
  const terminal = completed || failed
  const currentQueueHealth = current ? session.queueHealth?.[current.key] : null
  const workerWarning = currentQueueHealth?.warning
    ? currentQueueHealth
    : current
      ? null
      : Object.values(session.queueHealth ?? {}).find((health) => health.warning)

  const prevSessionIdRef = useRef(session.id)
  const prevStateRef = useRef(state)
  const collapseControllerRef = useRef(new IndicatorAutoCollapseController())
  const exitTimerRef = useRef<number | null>(null)
  const [presentation, setPresentation] = useState<IndicatorPresentation>(() => (
    initialIndicatorPresentation({
      sessionId: session.id,
      state,
      dismissedIds: dismissedIndicatorSessionIds,
      expandedIds: expandedTerminalSessionIds,
    })
  ))

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current == null) return
    window.clearTimeout(exitTimerRef.current)
    exitTimerRef.current = null
  }, [])

  const armAutoCollapse = useCallback(() => {
    const delayMs = resolveIndicatorCollapseDelayMs(state)
    const controller = collapseControllerRef.current
    if (delayMs == null) {
      controller.clear()
      return
    }
    controller.arm(delayMs, () => {
      if (dismissedIndicatorSessionIds.has(session.id)) return
      expandedTerminalSessionIds.delete(session.id)
      setPresentation((currentPhase) => presentationAfterCollapseRequest(currentPhase))
    })
  }, [session.id, state])

  // Progress polls must not rewrite presentation — only session identity / state transitions.
  useEffect(() => {
    const next = presentationForSessionTransition({
      previousSessionId: prevSessionIdRef.current,
      nextSessionId: session.id,
      previousState: prevStateRef.current,
      nextState: state,
      dismissedIds: dismissedIndicatorSessionIds,
      expandedIds: expandedTerminalSessionIds,
    })
    prevSessionIdRef.current = session.id
    prevStateRef.current = state
    if (!next) return
    if (next === 'expanded' && (state === 'completed' || state === 'failed')) {
      expandedTerminalSessionIds.add(session.id)
    }
    setPresentation(next)
  }, [session.id, state])

  const dismissForSession = useCallback(() => {
    dismissedIndicatorSessionIds.add(session.id)
    expandedTerminalSessionIds.delete(session.id)
    collapseControllerRef.current.clear()
    setPresentation((currentPhase) => presentationAfterCollapseRequest(currentPhase))
  }, [session.id])

  const expandFromIcon = useCallback(() => {
    if (dismissedIndicatorSessionIds.has(session.id)) return
    const next = presentationAfterExpand(false)
    if (!next) return
    if (terminal) expandedTerminalSessionIds.add(session.id)
    clearExitTimer()
    setPresentation(next)
    // Opening always cancels any prior arm and starts a fresh collapse window.
    armAutoCollapse()
  }, [armAutoCollapse, clearExitTimer, session.id, terminal])

  // Keep a single auto-collapse timer in sync with expanded terminal panels.
  // expandFromIcon also arms; this covers completion/failure transitions and
  // clears on collapse/dismiss. Cleanup always clears so remounts cannot leak.
  useEffect(() => {
    if (presentation !== 'expanded') {
      collapseControllerRef.current.clear()
      return
    }
    armAutoCollapse()
    return () => {
      collapseControllerRef.current.clear()
    }
  }, [armAutoCollapse, presentation])

  useEffect(() => {
    if (presentation !== 'exiting') {
      clearExitTimer()
      return
    }
    clearExitTimer()
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null
      setPresentation(presentationAfterExitAnimation(dismissedIndicatorSessionIds.has(session.id)))
    }, PANEL_EXIT_MS)
    return clearExitTimer
  }, [clearExitTimer, presentation, session.id])

  useEffect(() => () => {
    collapseControllerRef.current.clear()
    clearExitTimer()
  }, [clearExitTimer])

  if (presentation === 'dismissed') return null

  const statusIcon = completed
    ? <CheckCircle2 size={20} />
    : failed
      ? <AlertCircle size={20} />
      : workerWarning
        ? <AlertTriangle size={20} />
        : <RefreshCw size={19} className="motion-safe:animate-spin" />

  const toneClass = completed
    ? 'bg-emerald-100 text-emerald-700'
    : failed
      ? 'bg-red-100 text-red-700'
      : workerWarning
        ? 'bg-amber-100 text-amber-800'
        : 'bg-indigo-100 text-indigo-700'

  const title = completed
    ? 'Migration Completed'
    : failed
      ? 'Migration Failed'
      : workerWarning
        ? 'Worker Not Running'
        : 'QuickBooks Migration'

  const subtitle = completed
    ? `${overall.completed} modules completed`
    : failed
      ? 'Review logs or retry failed modules'
      : workerWarning?.warningMessage
        ?? `${overall.percent.toFixed(0)}% · ${current?.label ?? 'Waiting in queue'} · ${current?.progress?.currentStage?.replaceAll('_', ' ') ?? 'Importing…'}`

  if (presentation === 'collapsed') {
    return (
      <button
        type="button"
        aria-label={`Open ${title} notification`}
        data-global-migration-indicator={state}
        data-migration-indicator-presentation="collapsed"
        onClick={expandFromIcon}
        className="fixed bottom-4 right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-slate-200 bg-white shadow-lg shadow-slate-900/15 transition hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 sm:bottom-6 sm:right-6"
      >
        <span className={`flex h-10 w-10 items-center justify-center rounded-full ${toneClass}`}>
          {statusIcon}
        </span>
      </button>
    )
  }

  return (
    <aside
      aria-label="QuickBooks migration status"
      aria-live="polite"
      data-global-migration-indicator={state}
      data-migration-indicator-presentation={presentation}
      className={`fixed bottom-4 right-4 z-40 w-[min(20rem,calc(100%-2rem))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-slate-900/15 transition-[opacity,transform] duration-200 ease-out sm:bottom-6 sm:right-6 ${
        presentation === 'exiting' ? 'translate-y-2 opacity-0' : 'translate-y-0 opacity-100'
      }`}
    >
      {terminal && (
        <button
          type="button"
          aria-label="Dismiss migration notification"
          data-dismiss-migration-indicator
          onClick={dismissForSession}
          className="absolute right-2 top-2 z-10 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <X size={14} />
        </button>
      )}

      <button
        type="button"
        onClick={onOpen}
        className={`flex min-h-12 w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 ${
          terminal ? 'pr-9' : ''
        }`}
      >
        <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-xl ${toneClass}`}>
          {statusIcon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-slate-600">{subtitle}</span>
        </span>
        {running && <ChevronRight size={16} className="flex-none text-slate-400" />}
      </button>

      {running && (
        <div className="h-1 bg-slate-100" aria-hidden="true">
          <div className="h-full bg-indigo-600 transition-[width] duration-300" style={{ width: `${overall.percent}%` }} />
        </div>
      )}

      {failed && (
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-3 py-2">
          <Button size="sm" variant="outline" onClick={onLogs}>View Logs</Button>
          <Button size="sm" onClick={onRetry}>Retry</Button>
        </div>
      )}

      {error && (
        <p role="alert" className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</p>
      )}
    </aside>
  )
}
