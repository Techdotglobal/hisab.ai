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

/** Account subtypes that are structural or system-generated and never a customer-invoice revenue account. */
export const NON_POSTABLE_INVOICE_SUB_TYPES: ReadonlySet<string> = new Set([
  'Header',
  'UnappliedCashPaymentIncome',
])

/** Every FX account the company configured in currency_settings; posting reserves these for revaluation. */
export function fxReservedAccountIds(settings: {
  realizedGainAccountId: string | null
  realizedLossAccountId: string | null
  unrealizedGainAccountId: string | null
  unrealizedLossAccountId: string | null
} | null): Set<string> {
  if (!settings) return new Set()
  return new Set(
    [
      settings.realizedGainAccountId,
      settings.realizedLossAccountId,
      settings.unrealizedGainAccountId,
      settings.unrealizedLossAccountId,
    ].filter((id): id is string => Boolean(id)),
  )
}

/**
 * Income accounts a sales invoice line may post to: active; Income type; not a header or
 * system subtype; not a group that other active accounts roll up into; not an FX account
 * reserved by the company's currency settings.
 */
export function postableInvoiceLineAccounts<T extends InvoiceLineAccountCandidate>(
  accounts: T[],
  reservedAccountIds: ReadonlySet<string> = new Set(),
): T[] {
  const active = accounts.filter((account) => account.isActive !== false)
  const groupNumbers = new Set(
    active.map((account) => account.parentNo).filter((parent): parent is string => Boolean(parent)),
  )
  return active
    .filter(
      (account) =>
        account.accountType === INVOICE_LINE_REVENUE_ACCOUNT_TYPE &&
        !NON_POSTABLE_INVOICE_SUB_TYPES.has(String(account.subType)) &&
        !groupNumbers.has(account.accountNo) &&
        !reservedAccountIds.has(account.id),
    )
    .sort((a, b) => a.accountNo.localeCompare(b.accountNo, undefined, { numeric: true }))
}
