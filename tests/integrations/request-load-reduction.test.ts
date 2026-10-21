import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ACTIVE_POLL_MS, HIDDEN_ACTIVE_POLL_MS, IDLE_POLL_MS, isPollDue, pollIntervalFor,
} from '../../src/lib/import-export/wizard/migration-poll-schedule'
import { idlePollDelay } from '../../src/lib/platform/worker-backoff'

test('poll cadence: fast only for a running migration in a visible tab', () => {
  assert.equal(pollIntervalFor({ sessionState: 'running', hidden: false }), ACTIVE_POLL_MS)
  assert.equal(pollIntervalFor({ sessionState: 'running', hidden: true }), HIDDEN_ACTIVE_POLL_MS)
  for (const state of ['completed', 'failed', 'cancelled', null, undefined] as const) {
    assert.equal(pollIntervalFor({ sessionState: state, hidden: false }), IDLE_POLL_MS)
    assert.equal(pollIntervalFor({ sessionState: state, hidden: true }), null)
  }
})

test('a poll is due only once the cadence has elapsed; hidden idle tabs never poll', () => {
  const base = { sessionState: 'running' as const, hidden: false, lastPollAt: 1_000 }
  assert.equal(isPollDue({ ...base, now: 1_000 + ACTIVE_POLL_MS - 1 }), false)
  assert.equal(isPollDue({ ...base, now: 1_000 + ACTIVE_POLL_MS }), true)
  assert.equal(isPollDue({ sessionState: null, hidden: false, lastPollAt: 0, now: IDLE_POLL_MS - 1 }), false)
  assert.equal(isPollDue({ sessionState: null, hidden: false, lastPollAt: 0, now: IDLE_POLL_MS }), true)
  assert.equal(isPollDue({ sessionState: 'completed', hidden: true, lastPollAt: 0, now: 10 ** 9 }), false)
})

test('idle worker backoff grows to the cap and resets with a zero streak', () => {
  assert.equal(idlePollDelay(2000, 0, 15_000), 2000)
  assert.equal(idlePollDelay(2000, 1, 15_000), 2000)
  assert.equal(idlePollDelay(2000, 5, 15_000), 2000)
  assert.equal(idlePollDelay(2000, 6, 15_000), 4000)
  assert.equal(idlePollDelay(2000, 11, 15_000), 8000)
  assert.equal(idlePollDelay(2000, 500, 15_000), 15_000)
  assert.equal(idlePollDelay(2000, 500, 1_000), 2000, 'cap never goes below the base interval')
})

test('the single polling owner gates its network call and worker backs off on fatal start-up errors', () => {
  const provider = readFileSync('src/components/import-export/MigrationSessionProvider.tsx', 'utf8')
  assert.equal(provider.match(/window\.setInterval\(/g)?.length, 1, 'still exactly one poller')
  assert.match(provider, /isPollDue\(\{/)
  assert.match(provider, /visibilitychange/)
  const worker = readFileSync('worker/index.ts', 'utf8')
  assert.match(worker, /idlePollDelay\(pollIntervalMs, idleStreak, idleMaxMs\)/)
  assert.match(worker, /quickbooks_worker_fatal_backoff/)
})
