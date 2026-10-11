import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

export type ExpenseTransactionType = 'BILL' | 'EXPENSE' | 'PURCHASE_ORDER' | 'SUPPLIER_CREDIT' | 'CHEQUE'

export interface ExpenseTransaction {
  id: string
  type: ExpenseTransactionType
  date: string
  reference: string
  payee: string
  category: string
  subtotal: number
  taxAmount: number
  total: number
  currency: string
  status: string
  canMarkPaid: boolean
  sourceHref: string
}

function accountName(lines: unknown) {
  if (!Array.isArray(lines)) return '—'
  const first = lines[0] as { account?: { name?: string } | null } | undefined
  return first?.account?.name ?? '—'
}

function num(value: unknown) { return Number(value ?? 0) }

function mapRows(
  rows: {
    bills?: Record<string, unknown>[]
    expenses?: Record<string, unknown>[]
    purchaseOrders?: Record<string, unknown>[]
    supplierCredits?: Record<string, unknown>[]
    cheques?: Record<string, unknown>[]
  },
  fallbackCurrency: string,
): ExpenseTransaction[] {
  return [
    ...(rows.bills ?? []).map((row): ExpenseTransaction => ({
      id: String(row.id), type: 'BILL', date: String(row.date), reference: String(row.reference ?? row.notes ?? row.bill_no ?? ''),
      payee: (row.vendor as { name?: string } | null)?.name ?? '—', category: accountName(row.lines), subtotal: num(row.subtotal), taxAmount: num(row.tax_amount), total: num(row.total),
      currency: String(row.currency ?? fallbackCurrency), status: String(row.status), canMarkPaid: num(row.balance) > 0, sourceHref: '/bills',
    })),
    ...(rows.expenses ?? []).map((row): ExpenseTransaction => ({
      id: String(row.id), type: 'EXPENSE', date: String(row.date), reference: String(row.description ?? row.expense_no ?? ''), payee: '—',
      category: accountName(row.lines) !== '—' ? accountName(row.lines) : String(row.category ?? '—'), subtotal: num(row.total) - num(row.tax_amount), taxAmount: num(row.tax_amount), total: num(row.total),
      currency: String(row.currency ?? fallbackCurrency), status: String(row.status), canMarkPaid: false, sourceHref: '/expenses',
    })),
    ...(rows.purchaseOrders ?? []).map((row): ExpenseTransaction => ({
      id: String(row.id), type: 'PURCHASE_ORDER', date: String(row.date), reference: String(row.notes ?? row.po_no ?? ''),
      payee: (row.vendor as { name?: string } | null)?.name ?? '—', category: accountName(row.lines), subtotal: num(row.subtotal), taxAmount: num(row.tax_amount), total: num(row.total),
      currency: String(row.currency ?? fallbackCurrency), status: String(row.status), canMarkPaid: false, sourceHref: '/purchase-orders',
    })),
    ...(rows.supplierCredits ?? []).map((row): ExpenseTransaction => ({
      id: String(row.id), type: 'SUPPLIER_CREDIT', date: String(row.date), reference: String(row.notes ?? row.credit_no ?? ''),
      payee: (row.vendor as { name?: string } | null)?.name ?? '—', category: '—', subtotal: num(row.subtotal), taxAmount: num(row.tax_amount), total: num(row.total),
      currency: String(row.currency ?? fallbackCurrency), status: String(row.status), canMarkPaid: false, sourceHref: '/vendor-credits',
    })),
    ...(rows.cheques ?? []).map((row): ExpenseTransaction => ({
      id: String(row.id), type: 'CHEQUE', date: String(row.issue_date), reference: String(row.cheque_no ?? ''), payee: String(row.payee ?? '—'), category: '—',
      subtotal: num(row.amount), taxAmount: 0, total: num(row.amount), currency: String((row.bank_account as { currency?: string } | null)?.currency ?? fallbackCurrency),
      status: String(row.status), canMarkPaid: false, sourceHref: '/banking?tab=cheques',
    })),
  ]
}

const SORTS: Record<string, (a: ExpenseTransaction, b: ExpenseTransaction) => number> = {
  date: (a, b) => a.date.localeCompare(b.date), type: (a, b) => a.type.localeCompare(b.type), reference: (a, b) => a.reference.localeCompare(b.reference),
  payee: (a, b) => a.payee.localeCompare(b.payee), category: (a, b) => a.category.localeCompare(b.category), subtotal: (a, b) => a.subtotal - b.subtotal,
  taxAmount: (a, b) => a.taxAmount - b.taxAmount, total: (a, b) => a.total - b.total,
}

/** Prefer PostgREST message fields over String(error) → "[object Object]". */
export function formatExpenseTransactionsError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    for (const key of ['message', 'error', 'details', 'hint'] as const) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    try {
      return JSON.stringify(error)
    } catch {
      // fall through
    }
  }
  const text = String(error)
  return text === '[object Object]' ? 'Unexpected error while loading expense transactions' : text
}

export async function listExpenseTransactions(companyId: string, requestUrl: string) {
  const params = new URL(requestUrl).searchParams
  const client = createAdminClient()
  const companyRes = await client.from('companies').select('currency').eq('id', companyId).maybeSingle()
  if (companyRes.error) throw companyRes.error
  const fallbackCurrency = String(companyRes.data?.currency ?? 'SAR')

  // Do not select bills.currency / expenses.currency — some environments never applied
  // 022_transaction_currency.sql, and selecting a missing column fails the whole list.
  const [bills, expenses, purchaseOrders, supplierCredits, cheques] = await Promise.all([
    client.from('bills').select('id,date,bill_no,reference,notes,subtotal,tax_amount,total,status,balance,vendor:vendors(name),lines:bill_lines(account:chart_of_accounts(name))').eq('company_id', companyId).is('deleted_at', null).limit(1000),
    client.from('expenses').select('id,date,expense_no,description,category,total,tax_amount,status,lines:expense_lines(account:chart_of_accounts(name))').eq('company_id', companyId).is('deleted_at', null).limit(1000),
    client.from('purchase_orders').select('id,date,po_no,notes,subtotal,tax_amount,total,currency,status,vendor:vendors(name),lines:purchase_order_lines(account:chart_of_accounts(name))').eq('company_id', companyId).is('deleted_at', null).limit(1000),
    client.from('vendor_credits').select('id,date,credit_no,notes,subtotal,tax_amount,total,currency,status,vendor:vendors(name)').eq('company_id', companyId).is('deleted_at', null).limit(1000),
    client.from('cheques').select('id,issue_date,cheque_no,payee,amount,status,bank_account:bank_accounts(currency)').eq('company_id', companyId).is('deleted_at', null).limit(1000),
  ])
  for (const result of [bills, expenses, purchaseOrders, supplierCredits, cheques]) {
    if (result.error) throw result.error
  }
  let items = mapRows({
    bills: bills.data ?? [],
    expenses: expenses.data ?? [],
    purchaseOrders: purchaseOrders.data ?? [],
    supplierCredits: supplierCredits.data ?? [],
    cheques: cheques.data ?? [],
  }, fallbackCurrency)
  const type = params.get('type')
  const search = params.get('search')?.trim().toLowerCase()
  const payee = params.get('payee')?.trim().toLowerCase()
  const category = params.get('category')?.trim().toLowerCase()
  const dateFrom = params.get('dateFrom'); const dateTo = params.get('dateTo')
  const tax = params.get('tax'); const minTotal = params.get('minTotal'); const maxTotal = params.get('maxTotal')
  if (type && type !== 'ALL') items = items.filter((item) => item.type === type)
  if (search) items = items.filter((item) => [item.reference, item.payee, item.category, item.type].some((value) => value.toLowerCase().includes(search)))
  if (payee) items = items.filter((item) => item.payee.toLowerCase().includes(payee))
  if (category) items = items.filter((item) => item.category.toLowerCase().includes(category))
  if (dateFrom) items = items.filter((item) => item.date >= dateFrom)
  if (dateTo) items = items.filter((item) => item.date <= `${dateTo}T23:59:59.999Z`)
  if (tax === 'WITH_TAX') items = items.filter((item) => item.taxAmount > 0)
  if (tax === 'NO_TAX') items = items.filter((item) => item.taxAmount === 0)
  if (minTotal) items = items.filter((item) => item.total >= Number(minTotal))
  if (maxTotal) items = items.filter((item) => item.total <= Number(maxTotal))
  const sortBy = params.get('sortBy') ?? 'date'; const dir = params.get('sortDir') === 'asc' ? 1 : -1
  items.sort((a, b) => (SORTS[sortBy] ?? SORTS.date)(a, b) * dir)
  const total = items.length; const page = Math.max(1, Number(params.get('page') ?? 1)); const limit = Math.min(100, Math.max(1, Number(params.get('limit') ?? 25)))
  return { items: items.slice((page - 1) * limit, page * limit), total, page, limit }
}

/** Complete filtered dataset (every page), as a header row + data rows. */
export async function exportExpenseTransactions(companyId: string, requestUrl: string) {
  const url = new URL(requestUrl)
  const limit = 100
  const rows: Awaited<ReturnType<typeof listExpenseTransactions>>['items'] = []
  let page = 1
  let total = 0
  do {
    url.searchParams.set('page', String(page)); url.searchParams.set('limit', String(limit))
    const result = await listExpenseTransactions(companyId, url.toString())
    rows.push(...result.items)
    total = result.total
    page += 1
  } while (rows.length < total && page <= 1000)
  const headers = ['Date', 'Type', 'No.', 'Payee', 'Category', 'Total Before Sales Tax', 'Sales Tax', 'Total', 'Currency', 'Status']
  const body = rows.map((item) => [item.date, item.type, item.reference, item.payee, item.category, item.subtotal, item.taxAmount, item.total, item.currency, item.status])
  return { headers, rows: body }
}
