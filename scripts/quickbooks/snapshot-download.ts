/**
 * Read-only, resumable, throttled download of one raw QuickBooks snapshot from Storage.
 * Use this when the Supabase dashboard fails ("Failed to retrieve all files within folder") or rate-limits.
 * Deletes nothing unless --delete-after is passed; then it removes the snapshot's objects from Storage only after
 * every file is verified on disk (size match). Files that a documents.file_path points at are KEPT in Storage
 * (listed in _kept-referenced.txt); --force-referenced deletes those too.
 *
 *   npx tsx -r dotenv/config -r ./scripts/zatca/setup-server-only.cjs \
 *     scripts/quickbooks/snapshot-download.ts <snapshotId> [--out=./snapshot-backup] [--delay=250] [--list-only]
 *       [--delete-after] [--force-referenced]
 *
 * Files already present locally with the same size are skipped, so it is safe to re-run after a 429 / crash.
 */
import { loadEnvConfig } from '@next/env'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

loadEnvConfig(process.cwd())

const snapshotId = process.argv[2]
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const outRoot = arg('out') ?? './snapshot-backup'
const delayMs = Number(arg('delay') ?? 250)
const listOnly = process.argv.includes('--list-only')
const deleteAfter = process.argv.includes('--delete-after')
const forceReferenced = process.argv.includes('--force-referenced')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= 8) throw error
      const wait = Math.min(2 ** attempt * 1000, 60_000) // backoff on 429 / 5xx
      console.warn(`  ${label} failed (${error instanceof Error ? error.message : error}); retry ${attempt} in ${wait / 1000}s`)
      await sleep(wait)
    }
  }
}

async function main() {
  if (!snapshotId) throw new Error('Usage: snapshot-download.ts <snapshotId> [--out=dir] [--delay=ms] [--list-only]')
  const { createAdminClient } = await import('../../src/lib/supabase/admin')
  const { listObjectStats } = await import('../../src/lib/import-export/quickbooks/snapshot/snapshot-storage')
  const db = createAdminClient()

  const { data: snap, error } = await db
    .from('quickbooks_migration_snapshots')
    .select('id, status, storage_bucket, storage_prefix')
    .eq('id', snapshotId)
    .single()
  if (error) throw error
  const bucket = String(snap.storage_bucket)
  const prefix = String(snap.storage_prefix).replace(/\/+$/, '')
  console.log(`Snapshot ${snap.id} (${snap.status}) → ${bucket}/${prefix}`)

  const objects = await withRetry('list', () => listObjectStats(prefix))
  const totalBytes = objects.reduce((s, o) => s + o.bytes, 0)
  console.log(`${objects.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
  if (listOnly) return

  let done = 0
  let skipped = 0
  const failed: string[] = []
  for (const obj of objects) {
    const target = join(outRoot, snapshotId, obj.path)
    const existing = await stat(target).catch(() => null)
    if (existing && existing.size === obj.bytes && obj.bytes > 0) { skipped += 1; continue }
    try {
      const bytes = await withRetry(obj.path, async () => {
        const { data, error: dlError } = await db.storage.from(bucket).download(`${prefix}/${obj.path}`)
        if (dlError) throw dlError
        return Buffer.from(await data.arrayBuffer())
      })
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      done += 1
    } catch (e) {
      failed.push(obj.path)
      console.error(`  GAVE UP on ${obj.path}: ${e instanceof Error ? e.message : e}`)
    }
    if ((done + skipped) % 25 === 0) console.log(`  ${done + skipped}/${objects.length} (downloaded ${done}, already had ${skipped})`)
    await sleep(delayMs)
  }
  console.log(`Finished: downloaded ${done}, already present ${skipped}, failed ${failed.length}`)
  if (failed.length) {
    await writeFile(join(outRoot, snapshotId, '_failed.txt'), failed.join('\n'))
    console.log(`Failed paths listed in ${join(outRoot, snapshotId, '_failed.txt')} — re-run the same command to retry only those.`)
    process.exitCode = 1
    if (deleteAfter) console.log('Not deleting: the download is incomplete.')
    return
  }
  console.log('Complete: every listed file is now on disk.')
  if (!deleteAfter) return

  // Re-verify against disk (not just the loop counters) before anything is removed.
  const missing: string[] = []
  for (const obj of objects) {
    const onDisk = await stat(join(outRoot, snapshotId, obj.path)).catch(() => null)
    if (!onDisk || onDisk.size !== obj.bytes) missing.push(obj.path)
  }
  if (missing.length) {
    console.error(`Not deleting: ${missing.length} files are missing or have the wrong size on disk (first: ${missing[0]}).`)
    process.exitCode = 1
    return
  }

  // Migrated attachments make documents.file_path point straight at these objects.
  // Referenced objects are kept; everything else in the snapshot is deleted.
  const referenced = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data: docs, error: refError } = await db
      .from('documents')
      .select('file_path')
      .like('file_path', `%${prefix}/%`)
      .range(from, from + 999)
    if (refError) throw refError
    for (const d of docs ?? []) {
      const p = String(d.file_path)
      const i = p.indexOf(`${prefix}/`)
      if (i >= 0) referenced.add(p.slice(i))
    }
    if (!docs || docs.length < 1000) break
  }
  const keep = (full: string) => !forceReferenced && referenced.has(full)

  // attachments/ last, so the manifest and raw pages go first; the DB row is kept.
  const all = [...objects].sort((a, b) => Number(a.path.startsWith('attachments/')) - Number(b.path.startsWith('attachments/'))).map((o) => `${prefix}/${o.path}`)
  const paths = all.filter((p) => !keep(p))
  const kept = all.length - paths.length
  if (kept) {
    const keepFile = join(outRoot, snapshotId, '_kept-referenced.txt')
    await writeFile(keepFile, all.filter(keep).join('\n'))
    console.log(`Keeping ${kept} files still referenced by documents (listed in ${keepFile}).`)
  }
  console.log(`Deleting ${paths.length} objects from ${bucket} in batches of 50...`)
  let removed = 0
  for (let i = 0; i < paths.length; i += 50) {
    const batch = paths.slice(i, i + 50)
    await withRetry(`delete batch ${i / 50 + 1}`, async () => {
      const { error: rmError } = await db.storage.from(bucket).remove(batch)
      if (rmError) throw rmError
    })
    removed += batch.length
    console.log(`  deleted ${removed}/${paths.length}`)
    await sleep(Math.max(delayMs, 500))
  }
  console.log('Storage cleanup done. The quickbooks_migration_snapshots row was left in place.')
}

main().catch((e) => { console.error(e); process.exit(1) })
