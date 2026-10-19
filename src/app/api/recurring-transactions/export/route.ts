import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { authzErrorResponse } from '@/lib/authz'
import { requireRecurringPermission } from '@/lib/recurring-transactions/permissions'
import { exportRecurringTemplates } from '@/lib/recurring-transactions/service'
import { parseExportFormat, tableDownloadResponse } from '@/lib/export/serialize-table'

async function handleGet(request: Request) {
  try {
    const user = await requireAuth()
    const access = await requireRecurringPermission(user, 'export')
    const { headers, rows } = await exportRecurringTemplates(access.companyId, request.url)
    return tableDownloadResponse(parseExportFormat(new URL(request.url).searchParams.get('format')), 'recurring-transactions', headers, rows, 'Recurring Transactions')
  } catch (error) { return authzErrorResponse(error) }
}

export const GET = guarded(['invoices.view', 'bills.view', 'expenses.view'], handleGet)
