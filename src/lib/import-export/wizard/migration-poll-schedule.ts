import type { MigrationSessionState } from './migration-session'

/** Cadence while a migration is running and the tab is in front. */
export const ACTIVE_POLL_MS = 1_500
/** Running migration, but the tab is hidden: progress is not being watched. */
export const HIDDEN_ACTIVE_POLL_MS = 10_000
/** No running migration: only needed to notice one started elsewhere. */
export const IDLE_POLL_MS = 30_000

/**
 * How long the single polling owner should wait between status fetches, or null for "do not poll".
 * Every dashboard page mounts the poller, so an idle or background tab must cost (almost) nothing.
 */
export function pollIntervalFor(input: {
  sessionState: MigrationSessionState | null | undefined
  hidden: boolean
}): number | null {
  const active = input.sessionState === 'running'
  if (input.hidden) return active ? HIDDEN_ACTIVE_POLL_MS : null
  return active ? ACTIVE_POLL_MS : IDLE_POLL_MS
}

/** True when enough time has passed since the last fetch for the current cadence. */
export function isPollDue(input: {
  sessionState: MigrationSessionState | null | undefined
  hidden: boolean
  now: number
  lastPollAt: number
}): boolean {
  const interval = pollIntervalFor(input)
  return interval !== null && input.now - input.lastPollAt >= interval
}
