import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { apiError } from '@/lib/import-export/api-helpers'
import { resolveCompanyId } from '@/lib/tenant'
import { getSnapshot } from '@/lib/import-export/quickbooks/snapshot/snapshot.service'
import { buildSnapshotManifest } from '@/lib/import-export/quickbooks/snapshot/snapshot-manifest'
import { renderSnapshotReport } from '@/lib/import-export/quickbooks/snapshot/snapshot-report'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/** Human-readable snapshot report (COMPLETE / UNSUPPORTED / FAILED, separated). */
async function handleGet(_request: Request, { params }: { params: Promise<{ snapshotId: string }> }) {
  try {
    await requireAccountingAdmin()
    const companyId = await resolveCompanyId()
    const { snapshotId } = await params
    const snapshot = await getSnapshot(snapshotId, companyId)
    if (!snapshot) return Response.json({ error: 'Snapshot not found.' }, { status: 404 })

    const manifest = await buildSnapshotManifest(snapshot)
    return new Response(renderSnapshotReport(manifest), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
