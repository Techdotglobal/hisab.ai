export const INVOICE_LINE_REVENUE_ACCOUNT_TYPE = 'Income'

export interface InvoiceLineAccountCandidate {
  id: string
  accountNo: string
  name: string
  accountType?: string | null
  subType?: string | null
  parentNo?: string | null
  isActive?: boolean
}

/** Chart of Account display: canonical account_no and name, as used across the app. */
export function formatChartOfAccountLabel(account: Pick<InvoiceLineAccountCandidate, 'accountNo' | 'name'>): string {
  return `${account.accountNo} · ${account.name}`
}

/**
 * Income accounts a sales invoice line may post to: active, not a header, and not a
 * group that other active accounts roll up into.
 */
export function postableInvoiceLineAccounts<T extends InvoiceLineAccountCandidate>(accounts: T[]): T[] {
  const active = accounts.filter((account) => account.isActive !== false)
  const groupNumbers = new Set(
    active.map((account) => account.parentNo).filter((parent): parent is string => Boolean(parent)),
  )
  return active
    .filter(
      (account) =>
        account.accountType === INVOICE_LINE_REVENUE_ACCOUNT_TYPE &&
        account.subType !== 'Header' &&
        !groupNumbers.has(account.accountNo),
    )
    .sort((a, b) => a.accountNo.localeCompare(b.accountNo, undefined, { numeric: true }))
}
