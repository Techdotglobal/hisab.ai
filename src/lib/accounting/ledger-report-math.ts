/** Pure helpers for the General Ledger report (no I/O, safe to unit test). */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Inclusive UTC bounds for a ledger period. Date-only strings (YYYY-MM-DD) cover the whole
 * day, so entries posted at any time on the `to` date are included.
 */
export function ledgerRangeBounds(from: string | Date, to: string | Date): { fromIso: string; toIso: string } {
  const fromIso = typeof from === 'string' && DATE_ONLY.test(from) ? `${from}T00:00:00.000Z` : new Date(from).toISOString()
  const toIso = typeof to === 'string' && DATE_ONLY.test(to) ? `${to}T23:59:59.999Z` : new Date(to).toISOString()
  return { fromIso, toIso }
}

/**
 * Parses a report date parameter with the SAME inclusive-day semantics the General Ledger uses:
 * a date-only value (YYYY-MM-DD) is the start of that day as a lower bound and the end of that day
 * as an upper bound. Without this, P&L / Balance Sheet / Trial Balance / Cash Flow cut off at
 * midnight at the start of the `to` date and disagreed with the General Ledger for entries on that day.
 */
export function parseReportBound(value: string | null | undefined, edge: 'start' | 'end'): Date | undefined {
  if (!value) return undefined
  if (DATE_ONLY.test(value)) return new Date(`${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`)
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export interface DebitCredit { debit: number; credit: number }

export function sumDebitCredit(rows: DebitCredit[]): { debit: number; credit: number } {
  let debit = 0
  let credit = 0
  for (const r of rows) { debit += r.debit; credit += r.credit }
  return { debit: round4(debit), credit: round4(credit) }
}

export const round4 = (n: number) => Math.round(n * 10000) / 10000

/**
 * Running balance for one page of ledger rows. `startingBalance` is the balance carried in:
 * opening balance + net movement of all rows before this page.
 */
export function withRunningBalance<T extends DebitCredit>(rows: T[], startingBalance: number): (T & { balance: number })[] {
  let running = startingBalance
  return rows.map((row) => {
    running = round4(running + row.debit - row.credit)
    return { ...row, balance: running }
  })
}
