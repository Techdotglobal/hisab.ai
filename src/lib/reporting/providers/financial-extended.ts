import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { fetchAllRows } from '@/lib/db/repository-utils'
import {
  buildBalanceSheetFromLedger,
  buildProfitLossFromLedger,
  buildTrialBalance,
} from '@/lib/accounting/trial-balance'
import { aggregateLedgerBalances } from '@/lib/accounting/ledger'
import { buildCashFlowFromLedger } from '@/lib/accounting/cash-flow'
import { priorPeriod } from '../periods'
import type { ReportRunRequest } from '../types'

export async function runComparativeProfitLoss(req: ReportRunRequest) {
  const from = new Date(req.period!.from)
  const to = new Date(req.period!.to)
  const current = await buildProfitLossFromLedger({ from, to, companyId: req.companyId })
  const prior = req.comparePeriod
    ? await buildProfitLossFromLedger({
        from: new Date(req.comparePeriod.from),
        to: new Date(req.comparePeriod.to),
        companyId: req.companyId,
      })
    : await buildProfitLossFromLedger({
        from: new Date(priorPeriod(req.period!).from),
        to: new Date(priorPeriod(req.period!).to),
        companyId: req.companyId,
      })

  const variance = current.netProfit - prior.netProfit
  const variancePct = prior.netProfit !== 0 ? (variance / Math.abs(prior.netProfit)) * 100 : 0

  return {
    current,
    prior,
    variance: { amount: variance, percent: variancePct },
    rows: [
      { metric: 'Revenue', current: current.revenue.total, prior: prior.revenue.total },
      { metric: 'COGS', current: current.cogs.total, prior: prior.cogs.total },
      { metric: 'Gross Profit', current: current.grossProfit, prior: prior.grossProfit },
      { metric: 'Expenses', current: current.expenses.total, prior: prior.expenses.total },
      { metric: 'Net Profit', current: current.netProfit, prior: prior.netProfit, variance, variancePct },
    ],
  }
}

export async function runComparativeBalanceSheet(req: ReportRunRequest) {
  const asOf = new Date(req.asOf ?? req.period?.to ?? new Date())
  const current = await buildBalanceSheetFromLedger({ asOf, companyId: req.companyId })
  const priorDate = req.comparePeriod?.to
    ? new Date(req.comparePeriod.to)
    : new Date(asOf.getFullYear(), asOf.getMonth() - 1, asOf.getDate())
  const prior = await buildBalanceSheetFromLedger({ asOf: priorDate, companyId: req.companyId })

  return {
    current,
    prior,
    rows: [
      { section: 'Assets', current: current.assets.total, prior: prior.assets.total },
      { section: 'Liabilities', current: current.liabilities.total, prior: prior.liabilities.total },
      { section: 'Equity', current: current.equity.total, prior: prior.equity.total },
    ],
  }
}

export async function runRetainedEarnings(req: ReportRunRequest) {
  const from = new Date(req.period!.from)
  const to = new Date(req.period!.to)
  const pl = await buildProfitLossFromLedger({ from, to, companyId: req.companyId })
  const bs = await buildBalanceSheetFromLedger({ asOf: to, companyId: req.companyId })

  const retainedEarnings = bs.equity.items.find((i) =>
    i.name.toLowerCase().includes('retained'),
  )?.balance ?? bs.equity.total

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    openingRetainedEarnings: retainedEarnings - pl.netProfit,
    netIncome: pl.netProfit,
    closingRetainedEarnings: retainedEarnings,
    dividends: 0,
    rows: [
      { line: 'Opening Retained Earnings', amount: retainedEarnings - pl.netProfit },
      { line: 'Net Income', amount: pl.netProfit },
      { line: 'Closing Retained Earnings', amount: retainedEarnings },
    ],
  }
}

export async function runEquityStatement(req: ReportRunRequest) {
  const asOf = new Date(req.asOf ?? req.period?.to ?? new Date())
  const bs = await buildBalanceSheetFromLedger({ asOf, companyId: req.companyId })
  return {
    asOf: asOf.toISOString(),
    items: bs.equity.items,
    total: bs.equity.total,
    rows: bs.equity.items.map((i) => ({ accountNo: i.accountNo, name: i.name, balance: i.balance })),
  }
}

export async function runFinancialRatios(req: ReportRunRequest) {
  const from = new Date(req.period!.from)
  const to = new Date(req.period!.to)
  const pl = await buildProfitLossFromLedger({ from, to, companyId: req.companyId })
  const bs = await buildBalanceSheetFromLedger({ asOf: to, companyId: req.companyId })
  const cf = await buildCashFlowFromLedger({ from, to, companyId: req.companyId })

  const currentAssets = bs.assets.total
  const currentLiabilities = bs.liabilities.total
  const equity = bs.equity.total
  const revenue = pl.revenue.total
  const netProfit = pl.netProfit
  const grossProfit = pl.grossProfit

  const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0
  const debtToEquity = equity > 0 ? bs.liabilities.total / equity : 0
  const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0
  const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0
  const cashFlowMargin = revenue > 0 ? (cf.netCashFlow / revenue) * 100 : 0

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    ratios: { currentRatio, debtToEquity, grossMargin, netMargin, cashFlowMargin },
    rows: [
      { ratio: 'Current Ratio', value: currentRatio },
      { ratio: 'Debt to Equity', value: debtToEquity },
      { ratio: 'Gross Margin %', value: grossMargin },
      { ratio: 'Net Margin %', value: netMargin },
      { ratio: 'Cash Flow Margin %', value: cashFlowMargin },
    ],
  }
}

export async function runBudgetVsActual(req: ReportRunRequest) {
  const companyId = req.companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const from = new Date(req.period!.from)
  const to = new Date(req.period!.to)
  const fiscalYear = from.getFullYear()

  const { data: budgets } = await client
    .from('budgets')
    .select('id, name, fiscal_year, lines:budget_lines(account_id, period_month, amount)')
    .eq('company_id', companyId)
    .eq('fiscal_year', fiscalYear)
    .limit(1)

  const budget = budgets?.[0]
  const actualBalances = await aggregateLedgerBalances({
    companyId,
    from,
    to,
    canonicalTypes: ['Expense', 'CostOfGoodsSold', 'Income'],
  })

  const budgetByAccount = new Map<string, number>()
  for (const line of (budget?.lines as Array<{ account_id: string; period_month: number; amount: number }> | undefined) ?? []) {
    const month = line.period_month
    if (month >= from.getMonth() + 1 && month <= to.getMonth() + 1) {
      budgetByAccount.set(line.account_id, (budgetByAccount.get(line.account_id) ?? 0) + Number(line.amount))
    }
  }

  const rows = actualBalances
    .filter((b) => Math.abs(b.balance) > 0.0001)
    .map((b) => {
      const budgetAmount = budgetByAccount.get(b.accountId) ?? 0
      const actual = Math.abs(b.balance)
      const variance = actual - budgetAmount
      const variancePct = budgetAmount !== 0 ? (variance / budgetAmount) * 100 : 0
      return {
        accountNo: b.accountNo,
        accountName: b.accountName,
        canonicalType: b.canonicalType,
        budget: budgetAmount,
        actual,
        variance,
        variancePct,
      }
    })

  const totalBudget = rows.reduce((s, r) => s + r.budget, 0)
  const totalActual = rows.reduce((s, r) => s + r.actual, 0)

  return {
    budgetName: budget?.name ?? 'No budget',
    fiscalYear,
    period: { from: from.toISOString(), to: to.toISOString() },
    totalBudget,
    totalActual,
    totalVariance: totalActual - totalBudget,
    rows,
  }
}

export async function runJournalReport(req: ReportRunRequest) {
  const companyId = req.companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const from = new Date(req.period!.from)
  const to = new Date(req.period!.to)

  const { data, error } = await client
    .from('journal_entries')
    .select('id, entry_no, date, description, status, total_debit, total_credit, created_by:profiles(name)')
    .eq('company_id', companyId)
    .gte('date', from.toISOString())
    .lte('date', to.toISOString())
    .order('date', { ascending: false })

  if (error) throw error

  const rows = (data ?? []).map((j) => ({
    id: j.id,
    entryNo: j.entry_no,
    date: j.date,
    description: j.description,
    status: j.status,
    totalDebit: Number(j.total_debit ?? 0),
    totalCredit: Number(j.total_credit ?? 0),
    createdBy: (j.created_by as { name?: string } | null)?.name ?? '',
  }))

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    rows,
    totals: {
      count: rows.length,
      debit: rows.reduce((s, r) => s + r.totalDebit, 0),
      credit: rows.reduce((s, r) => s + r.totalCredit, 0),
    },
  }
}

export async function runCustomerLedger(req: ReportRunRequest) {
  const companyId = req.companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const customerId = req.filters?.find((f) => f.field === 'customerId')?.value as string | undefined
  const from = new Date(req.period!.from)
  const to = new Date(req.period!.to)

  const buildInvoiceQuery = () => {
    let query = client
      .from('invoices')
      .select('id, invoice_no, date, due_date, total, balance, status, customer:customers(id, name)')
      .eq('company_id', companyId)
      .gte('date', from.toISOString())
      .lte('date', to.toISOString())
      .is('deleted_at', null)
    if (customerId) query = query.eq('customer_id', customerId)
    return query.order('date').order('id')
  }

  const { data, error } = await fetchAllRows(buildInvoiceQuery)
  if (error) throw error

  const rows = (data ?? []).map((inv) => ({
    invoiceNo: inv.invoice_no,
    date: inv.date,
    customerName: (inv.customer as { name?: string } | null)?.name ?? '',
    total: Number(inv.total ?? 0),
    balance: Number(inv.balance ?? 0),
    status: inv.status,
  }))

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    rows,
    totalInvoiced: rows.reduce((s, r) => s + r.total, 0),
    totalOutstanding: rows.reduce((s, r) => s + r.balance, 0),
  }
}

export async function runVendorLedger(req: ReportRunRequest) {
  const companyId = req.companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const vendorId = req.filters?.find((f) => f.field === 'vendorId')?.value as string | undefined
  const from = new Date(req.period!.from)
  const to = new Date(req.period!.to)

  let query = client
    .from('bills')
    .select('id, bill_no, date, due_date, total, balance, status, vendor:vendors(id, name)')
    .eq('company_id', companyId)
    .gte('date', from.toISOString())
    .lte('date', to.toISOString())
    .is('deleted_at', null)
    .order('date')

  if (vendorId) query = query.eq('vendor_id', vendorId)

  const { data, error } = await query
  if (error) throw error

  const rows = (data ?? []).map((bill) => ({
    billNo: bill.bill_no,
    date: bill.date,
    vendorName: (bill.vendor as { name?: string } | null)?.name ?? '',
    total: Number(bill.total ?? 0),
    balance: Number(bill.balance ?? 0),
    status: bill.status,
  }))

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    rows,
    totalBilled: rows.reduce((s, r) => s + r.total, 0),
    totalOutstanding: rows.reduce((s, r) => s + r.balance, 0),
  }
}

export async function runTrialBalanceReport(req: ReportRunRequest) {
  const asOf = new Date(req.asOf ?? req.period?.to ?? new Date())
  return buildTrialBalance({
    asOf,
    from: req.period?.from ? new Date(req.period.from) : undefined,
    to: req.period?.to ? new Date(req.period.to) : asOf,
    companyId: req.companyId,
  })
}
