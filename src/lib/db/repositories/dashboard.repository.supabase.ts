import 'server-only'
import type { DashboardPayload } from '../entities'
import { fetchAllRows, resolveCompanyId, supabaseDb, toNumber } from '../repository-utils'
import { buildActivityFeed } from './dashboard-activity'
import type { DashboardRepository } from './dashboard.repository.interface'

const OPEN_INVOICE_STATUSES = ['DRAFT', 'SENT', 'PARTIAL', 'OVERDUE']
const OPEN_BILL_STATUSES = ['DRAFT', 'APPROVED', 'PARTIAL', 'OVERDUE']

function groupByStatus(rows: Record<string, unknown>[], statusKey: string, totalKey?: string) {
  const map = new Map<string, { _count: number; _sum: { total: number } }>()
  for (const row of rows) {
    const status = String(row[statusKey])
    const entry = map.get(status) ?? { _count: 0, _sum: { total: 0 } }
    entry._count += 1
    if (totalKey) entry._sum.total += toNumber(row[totalKey])
    map.set(status, entry)
  }
  return [...map.entries()].map(([status, value]) => ({ status, ...value }))
}

export const supabaseDashboardRepository: DashboardRepository = {
  async getStats() {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const now = new Date()

    const [
      invoicesRes,
      billsRes,
      expensesRes,
      payrollRes,
      customersRes,
      vendorsRes,
      accountsRes,
      journalRes,
      costCentersRes,
      employeesRes,
      inventoryRes,
      receiptsRes,
      paymentsRes,
      usersRes,
    ] = await Promise.all([
      // Each of these previously ran as a single unbounded select, which PostgREST caps at
      // its own server-side max-rows setting (commonly 1000) and silently truncates rather
      // than erroring. invoices (569) and bills (178) never crossed that line, but expenses
      // (1,393) and journal_entries (2,100+) did — showing "1000" on the dashboard tiles and,
      // worse, undercounting the totals summed from the truncated `expenses` array below.
      // fetchAllRows pages past the cap for every one of these so none of them can silently
      // regress the same way as a table grows.
      fetchAllRows(() => db.from('invoices').select('*').eq('company_id', companyId).is('deleted_at', null)),
      fetchAllRows(() => db.from('bills').select('*').eq('company_id', companyId).is('deleted_at', null)),
      fetchAllRows(() => db.from('expenses').select('*').eq('company_id', companyId).is('deleted_at', null)),
      fetchAllRows(() => db.from('payroll_entries').select('*').eq('company_id', companyId).is('deleted_at', null)),
      fetchAllRows(() => db.from('customers').select('id').eq('company_id', companyId).eq('is_active', true).is('deleted_at', null)),
      fetchAllRows(() => db.from('vendors').select('id').eq('company_id', companyId).eq('is_active', true).is('deleted_at', null)),
      fetchAllRows(() => db
        .from('chart_of_accounts')
        .select('id, sub_type')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .neq('sub_type', 'Header')
        .is('deleted_at', null)),
      fetchAllRows(() => db.from('journal_entries').select('id, status').eq('company_id', companyId).is('deleted_at', null)),
      fetchAllRows(() => db.from('cost_centers').select('id').eq('company_id', companyId).eq('is_active', true).is('deleted_at', null)),
      fetchAllRows(() => db.from('employees').select('id').eq('company_id', companyId).eq('is_active', true).is('deleted_at', null)),
      fetchAllRows(() => db.from('inventory_items').select('id').eq('company_id', companyId).eq('is_active', true).is('deleted_at', null)),
      fetchAllRows(() => db.from('receipts').select('id').eq('company_id', companyId).is('deleted_at', null)),
      fetchAllRows(() => db.from('payments').select('id').eq('company_id', companyId).is('deleted_at', null)),
      fetchAllRows(() => db.from('company_users').select('id').eq('company_id', companyId).eq('is_active', true)),
    ])

    for (const res of [
      invoicesRes,
      billsRes,
      expensesRes,
      payrollRes,
      customersRes,
      vendorsRes,
      accountsRes,
      journalRes,
      costCentersRes,
      employeesRes,
      inventoryRes,
      receiptsRes,
      paymentsRes,
      usersRes,
    ]) {
      if (res.error) throw res.error
    }

    const invoices = invoicesRes.data ?? []
    const bills = billsRes.data ?? []
    const expenses = (expensesRes.data ?? []).filter((e) => e.status !== 'REJECTED')
    const payrollEntries = payrollRes.data ?? []

    const activeInvoices = invoices.filter((i) => i.status !== 'VOID')
    const activeBills = bills.filter((b) => b.status !== 'VOID')

    const invoiceAgg = {
      _sum: {
        total: activeInvoices.reduce((s, i) => s + toNumber(i.total), 0),
        subtotal: activeInvoices.reduce((s, i) => s + toNumber(i.subtotal), 0),
        taxAmount: activeInvoices.reduce((s, i) => s + toNumber(i.tax_amount), 0),
        amountPaid: activeInvoices.reduce((s, i) => s + toNumber(i.amount_paid), 0),
      },
      _count: activeInvoices.length,
    }

    const billAgg = {
      _sum: {
        total: activeBills.reduce((s, b) => s + toNumber(b.total), 0),
        subtotal: activeBills.reduce((s, b) => s + toNumber(b.subtotal), 0),
        amountPaid: activeBills.reduce((s, b) => s + toNumber(b.amount_paid), 0),
      },
      _count: activeBills.length,
    }

    const expenseAgg = {
      _sum: { total: expenses.reduce((s, e) => s + toNumber(e.total), 0) },
      _count: expenses.length,
    }

    const payrollAgg = {
      _sum: { netSalary: payrollEntries.reduce((s, p) => s + toNumber(p.net_salary), 0) },
      _count: payrollEntries.length,
    }

    const openInvoices = activeInvoices.filter(
      (i) => OPEN_INVOICE_STATUSES.includes(String(i.status)) && toNumber(i.balance) > 0,
    )
    const openBills = activeBills.filter(
      (b) => OPEN_BILL_STATUSES.includes(String(b.status)) && toNumber(b.balance) > 0,
    )

    const receivablesAgg = {
      _sum: { balance: openInvoices.reduce((s, i) => s + toNumber(i.balance), 0) },
      _count: openInvoices.length,
    }
    const payablesAgg = {
      _sum: { balance: openBills.reduce((s, b) => s + toNumber(b.balance), 0) },
      _count: openBills.length,
    }

    const monthlyData: { month: string; revenue: number; expenses: number; bills: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59)
      const monthLabel = monthStart.toLocaleString('en', { month: 'short', year: '2-digit' })

      const inRange = (dateValue: string) => {
        const d = new Date(dateValue)
        return d >= monthStart && d <= monthEnd
      }

      monthlyData.push({
        month: monthLabel,
        revenue: activeInvoices
          .filter((inv) => inRange(String(inv.date)))
          .reduce((s, inv) => s + toNumber(inv.subtotal), 0),
        expenses: expenses
          .filter((exp) => inRange(String(exp.date)))
          .reduce((s, exp) => s + toNumber(exp.total), 0),
        bills: activeBills
          .filter((bill) => inRange(String(bill.date)))
          .reduce((s, bill) => s + toNumber(bill.subtotal), 0),
      })
    }

    const aging = { current: 0, days30: 0, days60: 0, days90plus: 0 }
    for (const inv of openInvoices) {
      const dueDate = new Date(String(inv.due_date))
      const days = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      const balance = toNumber(inv.balance)
      if (days <= 0) aging.current += balance
      else if (days <= 30) aging.days30 += balance
      else if (days <= 60) aging.days60 += balance
      else aging.days90plus += balance
    }

    const [
      recentInvoicesRes,
      recentBillsRes,
      recentExpensesRes,
      recentJournalRes,
      recentPayrollRes,
      recentPaymentsRes,
      recentCustomersRes,
      recentVendorsRes,
      recentEmployeesRes,
      recentInventoryRes,
      recentReceiptsRes,
      zatcaAuditRes,
    ] = await Promise.all([
      db
        .from('invoices')
        .select('*, customers(name)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(8),
      db
        .from('bills')
        .select('*, vendors(name)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(5),
      db
        .from('expenses')
        .select('id, expense_no, description, category, total, status, date, updated_at')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(5),
      db
        .from('journal_entries')
        .select('*, profiles:created_by_id(full_name)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(5),
      db
        .from('payroll_entries')
        .select('*, employees(name)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(5),
      db
        .from('payments')
        .select('*, invoices(invoice_no), bills(bill_no)')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(5),
      db
        .from('customers')
        .select('id, customer_no, name, created_at')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(3),
      db
        .from('vendors')
        .select('id, vendor_no, name, created_at')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(3),
      db
        .from('employees')
        .select('id, employee_no, name, department, created_at')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(3),
      db
        .from('inventory_items')
        .select('id, item_code, name, quantity, sale_price, updated_at')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .limit(3),
      db
        .from('receipts')
        .select('id, file_name, vendor, amount, status, created_at')
        .eq('company_id', companyId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(3),
      db
        .from('zatca_audit_logs')
        .select('id, action, result, message, invoice_id, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(10),
    ])

    for (const res of [
      recentInvoicesRes,
      recentBillsRes,
      recentExpensesRes,
      recentJournalRes,
      recentPayrollRes,
      recentPaymentsRes,
      recentCustomersRes,
      recentVendorsRes,
      recentEmployeesRes,
      recentInventoryRes,
      recentReceiptsRes,
      zatcaAuditRes,
    ]) {
      if (res.error) throw res.error
    }

    const recentInvoices = (recentInvoicesRes.data ?? []).map((row) => ({
      id: String(row.id),
      invoiceNo: String(row.invoice_no),
      total: toNumber(row.total),
      status: String(row.status),
      invoiceType: String(row.invoice_type ?? 'STANDARD'),
      zatcaStatus: String(row.zatca_status ?? 'DRAFT'),
      updatedAt: new Date(String(row.updated_at)),
      createdAt: new Date(String(row.created_at)),
      customer: { name: String((row.customers as { name?: string } | null)?.name ?? '') },
    }))

    const recentBills = (recentBillsRes.data ?? []).map((row) => ({
      id: String(row.id),
      billNo: String(row.bill_no),
      total: toNumber(row.total),
      status: String(row.status),
      updatedAt: new Date(String(row.updated_at)),
      vendor: { name: String((row.vendors as { name?: string } | null)?.name ?? '') },
    }))

    const recentExpenses = (recentExpensesRes.data ?? []).map((row) => ({
      id: String(row.id),
      expenseNo: String(row.expense_no),
      description: String(row.description),
      category: String(row.category),
      total: toNumber(row.total),
      status: String(row.status),
      date: new Date(String(row.date)),
      updatedAt: new Date(String(row.updated_at)),
    }))

    const recentJournal = (recentJournalRes.data ?? []).map((row) => ({
      id: String(row.id),
      entryNo: String(row.entry_no),
      description: String(row.description),
      status: String(row.status),
      totalDebit: toNumber(row.total_debit),
      updatedAt: new Date(String(row.updated_at)),
      createdBy: {
        name: ((row.profiles as { full_name?: string | null } | null)?.full_name ?? null) as string | null,
      },
    }))

    const recentPayroll = (recentPayrollRes.data ?? []).map((row) => ({
      id: String(row.id),
      payrollNo: String(row.payroll_no),
      netSalary: toNumber(row.net_salary),
      status: String(row.status),
      period: String(row.period),
      updatedAt: new Date(String(row.updated_at)),
      employee: { name: String((row.employees as { name?: string } | null)?.name ?? '') },
    }))

    const recentPayments = (recentPaymentsRes.data ?? []).map((row) => ({
      id: String(row.id),
      paymentNo: String(row.payment_no),
      amount: toNumber(row.amount),
      date: new Date(String(row.date)),
      invoice: row.invoices ? { invoiceNo: String((row.invoices as { invoice_no: string }).invoice_no) } : null,
      bill: row.bills ? { billNo: String((row.bills as { bill_no: string }).bill_no) } : null,
    }))

    const recentCustomers = (recentCustomersRes.data ?? []).map((row) => ({
      id: String(row.id),
      customerNo: String(row.customer_no),
      name: String(row.name),
      createdAt: new Date(String(row.created_at)),
    }))

    const recentVendors = (recentVendorsRes.data ?? []).map((row) => ({
      id: String(row.id),
      vendorNo: String(row.vendor_no),
      name: String(row.name),
      createdAt: new Date(String(row.created_at)),
    }))

    const recentEmployees = (recentEmployeesRes.data ?? []).map((row) => ({
      id: String(row.id),
      employeeNo: String(row.employee_no),
      name: String(row.name),
      department: (row.department as string | null) ?? null,
      createdAt: new Date(String(row.created_at)),
    }))

    const recentInventory = (recentInventoryRes.data ?? []).map((row) => ({
      id: String(row.id),
      itemCode: String(row.item_code),
      name: String(row.name),
      quantity: toNumber(row.quantity),
      salePrice: toNumber(row.sale_price),
      updatedAt: new Date(String(row.updated_at)),
    }))

    const recentReceipts = (recentReceiptsRes.data ?? []).map((row) => ({
      id: String(row.id),
      fileName: String(row.file_name),
      vendor: (row.vendor as string | null) ?? null,
      amount: row.amount != null ? toNumber(row.amount) : null,
      status: String(row.status),
      createdAt: new Date(String(row.created_at)),
    }))

    const zatcaAudit = (zatcaAuditRes.data ?? []).map((row) => ({
      id: String(row.id),
      action: String(row.action),
      result: String(row.result),
      message: (row.message as string | null) ?? null,
      invoiceId: (row.invoice_id as string | null) ?? null,
      createdAt: new Date(String(row.created_at)),
    }))

    const activity = buildActivityFeed({
      recentInvoices,
      recentBills,
      recentExpenses,
      recentJournal,
      recentPayroll,
      recentPayments,
      recentCustomers,
      recentVendors,
      recentEmployees,
      recentInventory,
      recentReceipts,
      zatcaAudit,
    })

    const totalRevenue = invoiceAgg._sum.subtotal
    const totalExpenses = expenseAgg._sum.total + billAgg._sum.subtotal + payrollAgg._sum.netSalary

    return {
      kpis: {
        totalRevenue,
        totalExpenses,
        totalInvoiced: invoiceAgg._sum.total,
        totalBilled: billAgg._sum.total,
        totalCollected: invoiceAgg._sum.amountPaid,
        totalPaidOut: billAgg._sum.amountPaid,
        payrollTotal: payrollAgg._sum.netSalary,
        accountsReceivable: receivablesAgg._sum.balance,
        accountsPayable: payablesAgg._sum.balance,
        openInvoices: receivablesAgg._count,
        openBills: payablesAgg._count,
      },
      counts: {
        customers: customersRes.data?.length ?? 0,
        vendors: vendorsRes.data?.length ?? 0,
        accounts: accountsRes.data?.length ?? 0,
        journalEntries: journalRes.data?.length ?? 0,
        costCenters: costCentersRes.data?.length ?? 0,
        employees: employeesRes.data?.length ?? 0,
        inventory: inventoryRes.data?.length ?? 0,
        receipts: receiptsRes.data?.length ?? 0,
        payments: paymentsRes.data?.length ?? 0,
        users: usersRes.data?.length ?? 0,
        invoices: invoiceAgg._count,
        bills: billAgg._count,
        expenses: expenseAgg._count,
        payroll: payrollAgg._count,
      },
      monthlyData,
      aging,
      statusBreakdown: {
        invoices: groupByStatus(activeInvoices, 'status', 'total'),
        bills: groupByStatus(activeBills, 'status', 'total'),
        journal: groupByStatus(journalRes.data ?? [], 'status'),
        expenses: groupByStatus(expenses, 'status', 'total'),
      },
      recentInvoices,
      recentBills,
      recentExpenses,
      recentJournal,
      recentPayroll,
      recentPayments,
      activity,
    } as DashboardPayload
  },
}
