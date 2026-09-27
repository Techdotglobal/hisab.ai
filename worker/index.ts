import { processJobBatch } from '@/lib/platform/jobs/workers'
import { assertImportJobSchemaCompatibility } from '@/lib/platform/schema-compatibility'

const pollIntervalMs = Math.max(250, Number(process.env.IMPORT_WORKER_POLL_MS ?? 2000))
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
    while (!stopping) {
      const result = await processJobBatch(1, ['QUICKBOOKS_IMPORT_STEP', 'QUICKBOOKS_SNAPSHOT_STEP'])
      if (result.processed === 0) await sleep(pollIntervalMs)
    }
  } finally {
    clearInterval(hbTimer)
    clearInterval(recoveryTimer)
  }

  console.log(JSON.stringify({ event: 'quickbooks_worker_stopped' }))
}

run().catch((error) => {
  console.error(JSON.stringify({
    event: 'quickbooks_worker_fatal',
    message: error instanceof Error ? error.message : String(error),
  }))
  process.exitCode = 1
})
