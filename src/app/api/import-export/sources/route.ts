import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { resolveCompanyId } from '@/lib/tenant'
import { apiError } from '@/lib/import-export/api-helpers'
import { listImportSources } from '@/lib/import-export/sources/source-registry'
import { createAccountingIntegrationRuntime } from '@/integrations/accounting/services/container'
import { Provider } from '@/integrations/accounting/contracts/types'

async function handleGet() {
  try {
    await requireAuth()
    const tenantId = await resolveCompanyId()
    const runtime = createAccountingIntegrationRuntime()
    const sources = await Promise.all(listImportSources().map(async (source) => {
      const status = await runtime.connections.getStatus(tenantId, source.key as Provider)
      return {
        ...source,
        connected: status.connected,
        connectionStatus: status.status,
        companyName: status.companyName,
        realmId: status.realmId,
        baseCurrency: status.baseCurrency,
        country: status.country,
        connectedAt: status.connectedAt,
        environment: status.environment,
        serverEnvironment: status.serverEnvironment,
        environmentMismatch: status.environmentMismatch,
        productionReady: status.productionReady,
      }
    }))
    return Response.json(sources)
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
