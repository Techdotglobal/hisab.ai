import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { apiError } from '@/lib/import-export/api-helpers'
import { resolveCompanyId } from '@/lib/tenant'
import { Provider } from '@/integrations/accounting/contracts/types'
import { createAccountingIntegrationRuntime } from '@/integrations/accounting/services/container'
import {
  allSnapshotResourceKeys,
  getSnapshotResourceSpec,
} from '@/lib/import-export/quickbooks/snapshot/snapshot-resources'
import { createSnapshot, listSnapshots } from '@/lib/import-export/quickbooks/snapshot/snapshot.service'
import { enqueueSnapshotStep } from '@/lib/import-export/quickbooks/snapshot/snapshot-orchestrator'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/** List this company's QuickBooks snapshots. */
async function handleGet() {
  try {
    await requireAccountingAdmin()
    const companyId = await resolveCompanyId()
    const snapshots = await listSnapshots(companyId)
    return Response.json(
      {
        snapshots: snapshots.map((snapshot) => ({
          id: snapshot.id,
          realmId: snapshot.realmId,
          status: snapshot.status,
          startedAt: snapshot.startedAt,
          completedAt: snapshot.completedAt,
          requestedResources: snapshot.requestedResources,
          extractorVersion: snapshot.extractorVersion,
        })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return apiError(error)
  }
}

/** Start a new raw-snapshot extraction for the connected QuickBooks company. */
async function handlePost(request: Request) {
  try {
    const user = await requireAccountingAdmin()
    const companyId = await resolveCompanyId()

    const body = (await request.json().catch(() => ({}))) as { resources?: unknown }
    const requestedResources = Array.isArray(body.resources)
      ? body.resources.filter((value): value is string => typeof value === 'string' && Boolean(getSnapshotResourceSpec(value)))
      : allSnapshotResourceKeys()
    if (!requestedResources.length) {
      return Response.json({ error: 'No known QuickBooks snapshot resources were requested.' }, { status: 400 })
    }

    const runtime = createAccountingIntegrationRuntime()
    const connection = await runtime.connections.assertMigrationConnectionReady(companyId, Provider.QUICKBOOKS)
    if (!connection.realmId) {
      return Response.json({ error: 'QuickBooks connection has no realm.' }, { status: 409 })
    }

    const sourceCompany = await runtime.connections
      .executeForProvider(companyId, Provider.QUICKBOOKS, (context) =>
        runtime.providers.get(Provider.QUICKBOOKS).getCompanyInfo(context),
      )
      .catch(() => null)

    const snapshot = await createSnapshot({
      companyId,
      realmId: connection.realmId,
      userId: user.id,
      requestedResources,
      sourceCompany: sourceCompany as Record<string, unknown> | null,
    })

    await enqueueSnapshotStep({ snapshotId: snapshot.id, companyId, userId: user.id })

    return Response.json(
      { snapshot: { id: snapshot.id, realmId: snapshot.realmId, status: snapshot.status, storagePrefix: snapshot.storagePrefix } },
      { status: 201 },
    )
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
export const POST = guarded('imports.run', handlePost)
