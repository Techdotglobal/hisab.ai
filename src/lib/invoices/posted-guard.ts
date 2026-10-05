export const POSTED_INVOICE_STATUSES = ['SENT', 'PARTIAL'] as const
export const POSTED_INVOICE_EDIT_ERROR = 'Cannot change financial fields of a posted invoice'
export const POSTED_INVOICE_DELETE_ERROR = 'Cannot delete posted invoice'

export function isPostedInvoiceStatus(status: string | null | undefined): boolean {
  return POSTED_INVOICE_STATUSES.includes(String(status) as (typeof POSTED_INVOICE_STATUSES)[number])
}

export interface PostedLineSignature {
  description: string
  quantity: number
  unitPrice: number
  taxRate: number
  taxRateId: string | null
  accountId: string | null
  projectId: string | null
  classId: string | null
  locationId?: string | null
  costCenterId?: string | null
  inventoryItemId?: string | null
  itemName: string | null
  amount: number
}

export function postedLineSignature(lines: PostedLineSignature[]): string {
  return JSON.stringify(
    lines.map((line) => [
      line.description,
      Number(line.quantity),
      Number(line.unitPrice),
      Number(line.taxRate),
      line.taxRateId ?? null,
      line.accountId ?? null,
      line.projectId ?? null,
      line.classId ?? null,
      line.locationId ?? null,
      line.costCenterId ?? null,
      line.inventoryItemId ?? null,
      line.itemName ?? null,
      Number(line.amount),
    ]),
  )
}

/** Names of financial fields whose submitted value differs from the stored value. Undefined = not submitted. */
export function changedPostedInvoiceFields(
  stored: Record<string, string | number | null>,
  submitted: Record<string, string | number | null | undefined>,
): string[] {
  return Object.keys(submitted).filter((key) => {
    const next = submitted[key]
    if (next === undefined) return false
    return String(next ?? '') !== String(stored[key] ?? '')
  })
}
