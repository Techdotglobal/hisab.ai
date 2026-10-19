import 'server-only'
import { aggregateLedgerBalances } from './ledger'
import { CURRENT_EARNINGS_ID, CURRENT_EARNINGS_LABEL, unclosedEarnings } from './balance-sheet-math'
import type { TrialBalanceRow } from './types'

export async function buildTrialBalance(options: {
  asOf?: Date
  from?: Date
  to?: Date
  companyId?: string
}): Promise<{
  asOf: string
  rows: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
  isBalanced: boolean
}> {
  const asOf = options.asOf ?? options.to ?? new Date()
  const balances = await aggregateLedgerBalances({
    companyId: options.companyId,
    asOf: options.asOf ?? options.to,
    from: options.from,
    to: options.to,
  })

  const rows: TrialBalanceRow[] = balances
    .filter((b) => b.totalDebit > 0 || b.totalCredit > 0 || Math.abs(b.balance) > 0.0001)
    .map((b) => ({
      accountId: b.accountId,
      accountNo: b.accountNo,
      accountName: b.accountName,
      canonicalType: b.canonicalType,
      normalBalance: b.normalBalance,
      debit: b.totalDebit,
      credit: b.totalCredit,
      balance: b.balance,
    }))
    .sort((a, b) => a.accountNo.localeCompare(b.accountNo))

  const totalDebit = rows.reduce((s, r) => s + r.debit, 0)
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0)

  return {
    asOf: asOf.toISOString(),
    rows,
    totalDebit,
    totalCredit,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
  }
}

export async function buildBalanceSheetFromLedger(options: { asOf: Date; companyId?: string }) {
  // All types are read so unclosed P&L earnings can be shown inside equity (see balance-sheet-math).
  const allBalances = await aggregateLedgerBalances({
    companyId: options.companyId,
    asOf: options.asOf,
  })
  const balances = allBalances.filter((b) => ['Asset', 'Liability', 'Equity'].includes(b.canonicalType))
  const earnings = unclosedEarnings(allBalances)

  const sections: Record<string, { accountId:string; accountNo: string; name: string; balance: number }[]> = {
    Asset: [],
    Liability: [],
    Equity: [],
  }

  for (const b of balances) {
    if (b.canonicalType in sections && Math.abs(b.balance) > 0.0001) {
      sections[b.canonicalType].push({
        accountId: b.accountId,
        accountNo: b.accountNo,
        name: b.accountName,
        balance: b.balance,
      })
    }
  }

  if (Math.abs(earnings) > 0.0001) {
    sections.Equity.push({ accountId: CURRENT_EARNINGS_ID, accountNo: '', name: CURRENT_EARNINGS_LABEL, balance: earnings })
  }

  const totalAssets = sections.Asset.reduce((s, a) => s + a.balance, 0)
  const totalLiabilities = sections.Liability.reduce((s, a) => s + a.balance, 0)
  const totalEquity = sections.Equity.reduce((s, a) => s + a.balance, 0)

  return {
    asOf: options.asOf.toISOString(),
    assets: { items: sections.Asset, total: totalAssets },
    liabilities: { items: sections.Liability, total: totalLiabilities },
    equity: { items: sections.Equity, total: totalEquity },
    totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  }
}

export async function buildProfitLossFromLedger(options: {
  from: Date
  to: Date
  companyId?: string
}) {
  const balances = await aggregateLedgerBalances({
    companyId: options.companyId,
    from: options.from,
    to: options.to,
    canonicalTypes: ['Income', 'Expense', 'CostOfGoodsSold'],
  })

  let totalRevenue = 0
  let totalCOGS = 0
  let totalExpenses = 0
  const revenueByAccount: { accountId:string; name: string; amount: number }[] = []
  const expenseByAccount: { accountId:string; name: string; amount: number }[] = []

  for (const b of balances) {
    if (b.canonicalType === 'Income') {
      totalRevenue += b.balance
      if (Math.abs(b.balance) > 0.0001) {
        revenueByAccount.push({ accountId:b.accountId, name: b.accountName, amount: b.balance })
      }
    } else if (b.canonicalType === 'CostOfGoodsSold') {
      totalCOGS += b.balance
    } else if (b.canonicalType === 'Expense') {
      totalExpenses += b.balance
      if (Math.abs(b.balance) > 0.0001) {
        expenseByAccount.push({ accountId:b.accountId, name: b.accountName, amount: b.balance })
      }
    }
  }

  const grossProfit = totalRevenue - totalCOGS
  const netProfit = grossProfit - totalExpenses

  return {
    period: { from: options.from.toISOString(), to: options.to.toISOString() },
    revenue: { total: totalRevenue, byAccount: revenueByAccount },
    cogs: { total: totalCOGS },
    grossProfit,
    expenses: { total: totalExpenses, byAccount: expenseByAccount },
    netProfit,
  }
}
