import type { CanonicalAccountType } from './types'

/**
 * Earnings that have not yet been closed into Retained Earnings: cumulative Income − COGS − Expense
 * up to the as-of date. Year-close entries zero the P&L accounts of closed years, so what remains in
 * those accounts is exactly the unclosed amount. Without this line the balance sheet cannot balance
 * whenever any P&L activity is still open, because profit sits in P&L accounts rather than equity.
 */
export function unclosedEarnings(balances: Array<{ canonicalType: CanonicalAccountType; balance: number }>): number {
  let income = 0
  let cogs = 0
  let expense = 0
  for (const b of balances) {
    if (b.canonicalType === 'Income') income += b.balance
    else if (b.canonicalType === 'CostOfGoodsSold') cogs += b.balance
    else if (b.canonicalType === 'Expense') expense += b.balance
  }
  return Math.round((income - cogs - expense) * 10000) / 10000
}

export const CURRENT_EARNINGS_ID = 'current-period-earnings'
export const CURRENT_EARNINGS_LABEL = 'Current period earnings (not yet closed)'
