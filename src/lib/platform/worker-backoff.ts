/**
 * Delay before the worker polls again after `idleStreak` consecutive empty polls.
 * Stays at the base interval for the first few empty polls (a continuation job often arrives right
 * after one finishes), then doubles every IDLE_STEP empty polls up to `maxMs`.
 */
const IDLE_STEP = 5

export function idlePollDelay(baseMs: number, idleStreak: number, maxMs: number): number {
  if (idleStreak <= 0) return baseMs
  const doublings = Math.floor((idleStreak - 1) / IDLE_STEP)
  return Math.min(Math.max(baseMs, maxMs), baseMs * 2 ** doublings)
}
