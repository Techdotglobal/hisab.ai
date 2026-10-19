import { guarded } from '@/lib/permissions/guard'
import PDFDocument from 'pdfkit'
import { requireAccountingRead as requireAuth } from '@/lib/product-parity/permissions'
import { migrationReportToCsv, type MigrationReport } from '@/lib/import-export/migration-report'
import { buildQuickBooksMigrationReport } from '@/lib/import-export/quickbooks/migration-report-service'

async function handleGet() {
  const user = await requireAuth()
  return Response.json(await buildQuickBooksMigrationReport(user.companyId), { headers:{ 'Cache-Control':'no-store' } })
}

function pdf(report: MigrationReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 42 })
    const chunks: Buffer[] = []
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
    document.font('Helvetica-Bold').fontSize(20).fillColor('#0f172a').text('Migration Report')
    document.moveDown(0.4).font('Helvetica').fontSize(10).fillColor('#475569')
    document.text(`Source: ${report.source}`)
    if (report.companyName) document.text(`Company: ${report.companyName}`)
    document.text(`Generated: ${report.generatedAt}`)
    document.moveDown().font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('Summary')
    document.font('Helvetica').fontSize(10)
    document.text(`Duration: ${(report.durationMs / 1000).toFixed(1)} seconds`)
    document.text(`Validation score: ${report.validationScore}%`)
    document.text(`Integrity score: ${report.integrityScore}%`)
    document.text(`Warnings: ${report.totals.warnings}   Failures: ${report.totals.failures}`)
    document.moveDown().font('Helvetica-Bold').text('Modules')
    document.moveDown(0.3).font('Helvetica').fontSize(9)
    for (const moduleReport of report.modules) {
      document.font('Helvetica-Bold').text(moduleReport.label)
      document.font('Helvetica').text(`Records ${moduleReport.sourceCount} | Imported ${moduleReport.importedCount} | Updated ${moduleReport.updatedCount} | Skipped ${moduleReport.skippedCount} | Failed ${moduleReport.failedCount} | Warnings ${moduleReport.warningCount} | ${moduleReport.durationMs} ms`)
      document.moveDown(0.45)
      if (document.y > document.page.height - 80) document.addPage()
    }
    document.end()
  })
}

async function handlePost(request: Request) {
  await requireAuth()
  const body = await request.json() as { format?: string; report?: MigrationReport }
  if (!body.report || !['pdf', 'csv', 'json'].includes(body.format ?? '')) return Response.json({ error: 'A report and format (pdf, csv, or json) are required.' }, { status: 400 })
  const format = body.format
  const filename = `migration-report-${new Date().toISOString().slice(0, 10)}`
  if (format === 'json') return new Response(JSON.stringify(body.report, null, 2), { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${filename}.json"` } })
  if (format === 'csv') return new Response(migrationReportToCsv(body.report), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}.csv"` } })
  const content = await pdf(body.report)
  return new Response(new Uint8Array(content), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}.pdf"` } })
}

export const GET = guarded('imports.view', handleGet)
export const POST = guarded('imports.run', handlePost)
