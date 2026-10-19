import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin } from '@/lib/product-parity/permissions'
import { recoverStaleImportJobs } from '@/lib/import-export/jobs/import-job.service'
import { apiError } from '@/lib/import-export/api-helpers'

async function handlePost() {
  try { await requireAccountingAdmin(); return Response.json({ recovered: await recoverStaleImportJobs() }) } catch (error) { return apiError(error) }
}

export const POST = guarded('imports.run', handlePost)
