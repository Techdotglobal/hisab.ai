import { guarded } from '@/lib/permissions/guard'
import { handleCostCenterTypedImport } from '@/lib/cost-centers/import/api-handler'

async function handlePost(request: Request) {
  return handleCostCenterTypedImport(request, 'location')
}

export const POST = guarded('cost_centers.manage', handlePost)
