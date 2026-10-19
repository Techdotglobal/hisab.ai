import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { generateCustomerStatementPdf, loadCustomerStatement } from '@/lib/sales/customer-statement'

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth()
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const format = searchParams.get('format') ?? 'json'
    const from = searchParams.get('from')
    const to = searchParams.get('to')

    const statement = await loadCustomerStatement(id, { from, to })

    if (format === 'pdf') {
      const pdf = await generateCustomerStatementPdf(statement)
      const filename = `statement-${statement.customer.customerNo}.pdf`
      const inline = searchParams.get('disposition') === 'inline'
      return new Response(new Uint8Array(pdf), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
          'Cache-Control': 'private, no-cache',
        },
      })
    }

    return Response.json(statement)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof Error && error.message === 'Customer not found') {
      return Response.json({ error: 'Customer not found' }, { status: 404 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('customers.view', handleGet)
