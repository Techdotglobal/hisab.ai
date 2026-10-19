import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getImportJobSkips } from '@/lib/import-export/jobs/import-job.service'
import { apiError } from '@/lib/import-export/api-helpers'

function csvValue(value: unknown): string {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function handleGet(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    await requireAuth()
    const { jobId } = await params
    const rows = await getImportJobSkips(jobId)
    if (new URL(request.url).searchParams.get('format') === 'csv') {
      const csv = [['QuickBooks ID', 'Record name', 'Skip reason', 'Existing Hisab record ID', 'Duplicate field used for matching'], ...rows.map((row) => [row.sourceId, row.recordName, row.reason, row.existingRecordId, row.duplicateKey])].map((row) => row.map(csvValue).join(',')).join('\r\n')
      return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${jobId}-skipped-records.csv"`, 'Cache-Control': 'no-store' } })
    }
    return Response.json({ jobId, rows }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return apiError(error)
  }
}

export const GET = guarded('imports.view', handleGet)
