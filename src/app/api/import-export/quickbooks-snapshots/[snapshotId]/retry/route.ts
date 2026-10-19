import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { apiError } from '@/lib/import-export/api-helpers'
import { resolveCompanyId } from '@/lib/tenant'
import { getSnapshot, reopenSnapshotForRetry } from '@/lib/import-export/quickbooks/snapshot/snapshot.service'
import { enqueueSnapshotStep } from '@/lib/import-export/quickbooks/snapshot/snapshot-orchestrator'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/** Resume a PARTIAL/FAILED snapshot: reset failed/stuck resources and re-enqueue extraction. */
async function handlePost(_request: Request, { params }: { params: Promise<{ snapshotId: string }> }) {
  try {
    const user = await requireAccountingAdmin()
    const companyId = await resolveCompanyId()
    const { snapshotId } = await params

    const snapshot = await getSnapshot(snapshotId, companyId)
    if (!snapshot) return Response.json({ error: 'Snapshot not found.' }, { status: 404 })
    if (snapshot.status === 'COMPLETE') {
      return Response.json({ error: 'Snapshot is already COMPLETE.' }, { status: 409 })
    }

    const retried = await reopenSnapshotForRetry(snapshotId, companyId)
    await enqueueSnapshotStep({ snapshotId, companyId, userId: user.id })

    return Response.json({ snapshotId, status: 'RUNNING', retriedResources: retried })
  } catch (error) {
    return apiError(error)
  }
}

export const POST = guarded('imports.run', handlePost)
