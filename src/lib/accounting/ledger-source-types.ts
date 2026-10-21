/**
 * "Class of transaction" in the General Ledger is the ledger entry's `source_type`
 * (enum `public.ledger_source_type`, see migrations 025/032/033/034/050/052/063).
 * No separate class column exists, so the filter maps onto that enum.
 */
export const LEDGER_SOURCE_TYPES = [
  { value: 'JOURNAL', label: 'Journal Entry' },
  { value: 'INVOICE', label: 'Invoice' },
  { value: 'BILL', label: 'Bill' },
  { value: 'EXPENSE', label: 'Expense' },
  { value: 'PAYMENT', label: 'Payment' },
  { value: 'PAYROLL', label: 'Payroll' },
  { value: 'SALES_RECEIPT', label: 'Sales Receipt' },
  { value: 'REFUND_RECEIPT', label: 'Refund Receipt' },
  { value: 'REFUND_RECEIPT_VOID', label: 'Refund Receipt (Void)' },
  { value: 'SUPPLIER_CREDIT', label: 'Supplier Credit' },
  { value: 'CREDIT_CARD_PAYMENT', label: 'Credit Card Payment' },
  { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
  { value: 'DEPOSIT', label: 'Deposit' },
  { value: 'TAX_PAYMENT', label: 'Tax Payment' },
  { value: 'TAX_REFUND', label: 'Tax Refund' },
  { value: 'INVENTORY', label: 'Inventory' },
  { value: 'FX_REVALUATION', label: 'FX Revaluation' },
  { value: 'REALIZED_FX', label: 'Realized FX' },
  { value: 'UNREALIZED_FX', label: 'Unrealized FX' },
  { value: 'ADJUSTMENT', label: 'Adjustment' },
  { value: 'OPENING_BALANCE', label: 'Opening Balance' },
  { value: 'REVERSAL', label: 'Reversal' },
  { value: 'YEAR_CLOSE', label: 'Year Close' },
] as const

const VALID = new Set<string>(LEDGER_SOURCE_TYPES.map((t) => t.value))

export function isLedgerSourceType(value: string): boolean {
  return VALID.has(value)
}

export function ledgerSourceLabel(value: string | null | undefined): string {
  if (!value) return ''
  return LEDGER_SOURCE_TYPES.find((t) => t.value === value)?.label ?? value
}
