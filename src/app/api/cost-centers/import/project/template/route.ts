import { guarded } from '@/lib/permissions/guard'
import { handleCostCenterTemplateDownload } from '@/lib/cost-centers/import/template-handler'

async function handleGet() {
  return handleCostCenterTemplateDownload('project')
}

export const GET = guarded('cost_centers.view', handleGet)
