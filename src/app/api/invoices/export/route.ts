import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getInvoiceRepository } from '@/lib/db/provider'
import type { InvoiceListOptions } from '@/lib/db/repositories/invoice.repository.interface'
import type { InvoiceRecord } from '@/lib/db/entities'
import { parseExportFormat, tableDownloadResponse } from '@/lib/export/serialize-table'

function pickParam(searchParams: URLSearchParams, key: string) {
  const value = searchParams.get(key)
  return value && value.trim() ? value.trim() : undefined
}

const PAGE_SIZE = 100
const MAX_PAGES = 1000

/**
 * Exports the complete invoice list for the active filters/search (every page),
 * using the same repository query as the on-screen table so both stay consistent.
 */
async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const base: InvoiceListOptions = {
      search: pickParam(searchParams, 'search'),
      status: pickParam(searchParams, 'status'),
      zatcaStatus: pickParam(searchParams, 'zatcaStatus'),
      invoiceType: pickParam(searchParams, 'invoiceType'),
      customerId: pickParam(searchParams, 'customerId'),
      datePreset: pickParam(searchParams, 'datePreset') as InvoiceListOptions['datePreset'],
      dateFrom: pickParam(searchParams, 'dateFrom'),
      dateTo: pickParam(searchParams, 'dateTo'),
      overdue: searchParams.get('overdue') === 'true' ? true : undefined,
      sortBy: pickParam(searchParams, 'sortBy') as InvoiceListOptions['sortBy'],
      sortDir: pickParam(searchParams, 'sortDir') as InvoiceListOptions['sortDir'],
      limit: PAGE_SIZE,
    }

    const repo = getInvoiceRepository()
    const items: InvoiceRecord[] = []
    let page = 1
    let total = 0
    do {
      const result = await repo.findMany({ ...base, page })
      items.push(...result.items)
      total = result.total
      if (result.items.length === 0) break
      page += 1
    } while (items.length < total && page <= MAX_PAGES)

    const headers = ['Invoice No', 'Type', 'Customer', 'Invoice Date', 'Due Date', 'Currency', 'Subtotal', 'Tax', 'Total', 'Amount Paid', 'Balance', 'Status', 'ZATCA Status']
    const rows = items.map((inv) => [
      inv.invoiceNo,
      inv.invoiceType,
      (inv.customer as { name?: string } | undefined)?.name ?? '',
      inv.date,
      inv.dueDate,
      inv.currency,
      inv.subtotal,
      inv.taxAmount,
      inv.total,
      inv.amountPaid,
      inv.balance,
      inv.status,
      inv.zatcaStatus,
    ])
    return tableDownloadResponse(parseExportFormat(searchParams.get('format')), 'invoices', headers, rows, 'Invoices')
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
