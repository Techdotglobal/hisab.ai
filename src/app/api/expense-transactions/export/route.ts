import { requireRole, authzErrorResponse } from '@/lib/authz'
import { exportExpenseTransactions } from '@/lib/expense-transactions/service'
import { parseExportFormat, tableDownloadResponse } from '@/lib/export/serialize-table'

export async function GET(request: Request) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'AUDITOR'])
    const { headers, rows } = await exportExpenseTransactions(user.companyId, request.url)
    return tableDownloadResponse(parseExportFormat(new URL(request.url).searchParams.get('format')), 'expense-transactions', headers, rows, 'Expense Transactions')
  } catch (error) { return authzErrorResponse(error) }
}
