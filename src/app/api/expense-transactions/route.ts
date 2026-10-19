import { guarded } from '@/lib/permissions/guard'
import { requireRole, authzErrorResponse } from '@/lib/authz'
import { formatExpenseTransactionsError, listExpenseTransactions } from '@/lib/expense-transactions/service'

async function handleGet(request: Request) {
  try {
    const user = await requireRole(['OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER', 'AUDITOR'])
    return Response.json(await listExpenseTransactions(user.companyId, request.url))
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[expense-transactions]', formatExpenseTransactionsError(error), error)
    }
    return authzErrorResponse(error)
  }
}

export const GET = guarded('expenses.view', handleGet)
