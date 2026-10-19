import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { runReport } from '@/lib/reporting/runner'
import { runCustomDefinition } from '@/lib/reporting/custom'
import { exportReport } from '@/lib/reporting/export'
import type { ReportExportFormat, ReportRunRequest } from '@/lib/reporting/types'

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const body = await request.json() as ReportRunRequest & {
      definitionId?: string
      format?: ReportExportFormat
      email?: string
    }

    const format = body.format ?? 'csv'
    const result = body.definitionId
      ? await runCustomDefinition(body.definitionId, body)
      : await runReport(body)

    const exported = await exportReport(result, format)

    if (body.email) {
      return Response.json({
        success: true,
        message: `Export queued for ${body.email} (delivery hook pending SMTP configuration)`,
        filename: exported.filename,
      })
    }

    return new Response(exported.content as BodyInit, {
      headers: {
        'Content-Type': exported.mimeType,
        'Content-Disposition': `attachment; filename="${exported.filename}"`,
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('reports.export', handlePost)
