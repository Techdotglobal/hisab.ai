import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { apiError } from '@/lib/import-export/api-helpers'
import { resolveCompanyId } from '@/lib/tenant'
import { getSnapshot } from '@/lib/import-export/quickbooks/snapshot/snapshot.service'
import { buildSnapshotManifest } from '@/lib/import-export/quickbooks/snapshot/snapshot-manifest'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/** Snapshot status + manifest summary. */
async function handleGet(_request: Request, { params }: { params: Promise<{ snapshotId: string }> }) {
  try {
    await requireAccountingAdmin()
    const companyId = await resolveCompanyId()
    const { snapshotId } = await params
    const snapshot = await getSnapshot(snapshotId, companyId)
    if (!snapshot) return Response.json({ error: 'Snapshot not found.' }, { status: 404 })

    const manifest = await buildSnapshotManifest(snapshot).catch(() => null)
    return Response.json(
      {
        snapshot: {
          id: snapshot.id,
          realmId: snapshot.realmId,
          status: snapshot.status,
          startedAt: snapshot.startedAt,
          completedAt: snapshot.completedAt,
          extractorVersion: snapshot.extractorVersion,
          storagePrefix: snapshot.storagePrefix,
          requiredResources: manifest?.requiredResources ?? [],
          requestedResources: snapshot.requestedResources,
          entities: snapshot.entities,
          errors: snapshot.errors,
          warnings: snapshot.warnings,
          validation: snapshot.validation,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
