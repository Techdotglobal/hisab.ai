export const INVOICE_LINE_REVENUE_ACCOUNT_TYPE = 'Income'

export interface InvoiceLineAccountCandidate {
  id: string
  accountNo: string
  name: string
  accountType?: string | null
  isActive?: boolean
}

export function postableInvoiceLineAccounts<T extends InvoiceLineAccountCandidate>(accounts: T[]): T[] {
  return accounts
    .filter((account) => account.accountType === INVOICE_LINE_REVENUE_ACCOUNT_TYPE && account.isActive !== false)
    .sort((a, b) => a.accountNo.localeCompare(b.accountNo, undefined, { numeric: true }))
}
