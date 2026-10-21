import { processJobBatch } from '@/lib/platform/jobs/workers'
import { assertImportJobSchemaCompatibility } from '@/lib/platform/schema-compatibility'
import { idlePollDelay } from '@/lib/platform/worker-backoff'

const pollIntervalMs = Math.max(250, Number(process.env.IMPORT_WORKER_POLL_MS ?? 2000))
const idleMaxMs = Math.max(pollIntervalMs, Number(process.env.IMPORT_WORKER_IDLE_MAX_MS ?? 15_000))
/** A fatal start-up error (e.g. database restricted) waits before exiting so the supervisor's restart loop is slow. */
const fatalExitDelayMs = Math.max(0, Number(process.env.WORKER_FATAL_EXIT_DELAY_MS ?? 60_000))
let stopping = false

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function requestShutdown(signal: string) {
  stopping = true
  console.log(JSON.stringify({ event: 'quickbooks_worker_shutdown_requested', signal }))
}

process.once('SIGTERM', () => requestShutdown('SIGTERM'))
process.once('SIGINT', () => requestShutdown('SIGINT'))

async function run() {
  await assertImportJobSchemaCompatibility()
  const workerName = process.env.WORKER_NAME ?? `quickbooks-worker-${process.pid}`
  console.log(JSON.stringify({ event: 'quickbooks_worker_started', pollIntervalMs, workerName }))

  // Start heartbeat loop independent of job processing
  const { touchWorkerHeartbeat } = await import('@/lib/platform/worker-heartbeat')
  const hbInterval = Math.max(5000, Number(process.env.WORKER_HEARTBEAT_MS ?? 30_000))
  const logHeartbeatFailure = (error: unknown) => console.error(JSON.stringify({
    event: 'quickbooks_worker_heartbeat_failed',
    message: error instanceof Error ? error.message : String(error),
  }))
  const hbTimer = setInterval(() => { touchWorkerHeartbeat(workerName, process.pid).catch(logHeartbeatFailure) }, hbInterval)
  // Run immediately once
  await touchWorkerHeartbeat(workerName, process.pid).catch(logHeartbeatFailure)

  // Start continuation recovery loop in parallel
  const { recoverOrphanedContinuations } = await import('@/lib/platform/continuation-scheduler')
  const recoveryInterval = Math.max(10_000, Number(process.env.WORKER_RECOVERY_MS ?? 30_000))
  const logRecoveryFailure = (error: unknown) => console.error(JSON.stringify({
    event: 'quickbooks_worker_recovery_failed',
    message: error instanceof Error ? error.message : String(error),
  }))
  const recoveryTimer = setInterval(() => { recoverOrphanedContinuations().catch(logRecoveryFailure) }, recoveryInterval)

  try {
    // Idle polling backs off (2s -> IMPORT_WORKER_IDLE_MAX_MS) and snaps back as soon as work appears.
    let idleStreak = 0
    while (!stopping) {
      const result = await processJobBatch(1, ['QUICKBOOKS_IMPORT_STEP', 'QUICKBOOKS_SNAPSHOT_STEP'])
      if (result.processed === 0) {
        idleStreak += 1
        await sleep(idlePollDelay(pollIntervalMs, idleStreak, idleMaxMs))
      } else {
        idleStreak = 0
      }
    }
  } finally {
    clearInterval(hbTimer)
    clearInterval(recoveryTimer)
  }

  console.log(JSON.stringify({ event: 'quickbooks_worker_stopped' }))
}

run().catch(async (error) => {
  console.error(JSON.stringify({
    event: 'quickbooks_worker_fatal',
    message: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
  if (!stopping && fatalExitDelayMs > 0) {
    console.error(JSON.stringify({ event: 'quickbooks_worker_fatal_backoff', delayMs: fatalExitDelayMs }))
    await sleep(fatalExitDelayMs)
  }
})
