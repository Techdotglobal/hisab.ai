import { DEFAULT_CURRENCY, normalizeCurrency } from '@/lib/currency/constants'
import type {
  ChartOfAccountRecord,
  CostCenterRecord,
  CustomerRecord,
  EmployeeRecord,
  InventoryItemRecord,
  InvoiceAttachmentRecord,
  InvoiceLineRecord,
  InvoiceRecord,
  PaymentRecord,
  PayrollEntryRecord,
  PayrollLineRecord,
  TaxRateRecord,
  VendorRecord,
  ZatcaAuditLogRecord,
} from './entities'
import { resolveAccountClassification } from '@/lib/accounting/account-type-map'
import { requireDate, toDate, toNumber } from './repository-utils'

export function mapCustomerRow(row: Record<string, unknown>): CustomerRecord {
  return {
    id: String(row.id),
    customerNo: String(row.customer_no),
    name: String(row.name),
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    streetAddress: (row.street_address as string | null) ?? null,
    buildingNumber: (row.building_number as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    postalCode: (row.postal_code as string | null) ?? null,
    taxId: (row.tax_id as string | null) ?? null,
    creditLimit: toNumber(row.credit_limit),
    paymentTerms: Number(row.payment_terms ?? 30),
    isActive: Boolean(row.is_active ?? true),
    createdAt: requireDate(String(row.created_at)),
    updatedAt: requireDate(String(row.updated_at)),
  }
}

export function mapVendorRow(row: Record<string, unknown>): VendorRecord {
  return {
    id: String(row.id),
    vendorNo: String(row.vendor_no),
    name: String(row.name),
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    country: (row.country as string | null) ?? null,
    taxId: (row.tax_id as string | null) ?? null,
    paymentTerms: Number(row.payment_terms ?? 30),
    isActive: Boolean(row.is_active ?? true),
    createdAt: requireDate(String(row.created_at)),
    updatedAt: requireDate(String(row.updated_at)),
  }
}

export function mapChartOfAccountRow(row: Record<string, unknown>): ChartOfAccountRecord {
  return {
    id: String(row.id),
    accountNo: String(row.account_no),
    fullName: String(row.full_name),
    name: String(row.name),
    parentNo: (row.parent_no as string | null) ?? null,
    parentId: (row.parent_id as string | null) ?? null,
    accountType: String(row.account_type),
    subType: String(row.sub_type),
    canonicalType: (row.canonical_type as string | null) ?? null,
    normalBalance: (row.normal_balance as string | null) ?? null,
    isActive: Boolean(row.is_active ?? true),
    description: (row.description as string | null) ?? null,
    balance: toNumber(row.balance),
    legacyId: (row.legacy_id as string | null) ?? null,
    createdAt: requireDate(String(row.created_at)),
    updatedAt: requireDate(String(row.updated_at)),
  }
}

function jsonToString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function mapInvoiceRow(row: Record<string, unknown>): InvoiceRecord {
  return {
    id: String(row.id),
    invoiceNo: String(row.invoice_no),
    invoiceUUID: (row.invoice_uuid as string | null) ?? null,
    invoiceHash: (row.invoice_hash as string | null) ?? null,
    previousInvoiceHash: (row.previous_invoice_hash as string | null) ?? null,
    invoiceType: String(row.invoice_type ?? 'STANDARD'),
    referencedInvoiceId: (row.referenced_invoice_id as string | null) ?? null,
    customerId: String(row.customer_id),
    date: requireDate(String(row.date)),
    issueTime: (row.issue_time as string | null) ?? null,
    dueDate: requireDate(String(row.due_date)),
    expiryDate: toDate(row.expiry_date as string | null | undefined),
    currency: normalizeCurrency(String(row.currency ?? DEFAULT_CURRENCY)),
    status: String(row.status ?? 'DRAFT'),
    subtotal: toNumber(row.subtotal),
    taxAmount: toNumber(row.tax_amount),
    total: toNumber(row.total),
    amountPaid: toNumber(row.amount_paid),
    balance: toNumber(row.balance),
    taxCalculationMethod: String(row.tax_calculation_method ?? 'TAX_EXCLUSIVE'),
    paymentTermId: (row.payment_term_id as string | null) ?? null,
    zatcaStatus: String(row.zatca_status ?? 'DRAFT'),
    clearanceStatus: (row.clearance_status as string | null) ?? null,
    zatcaResponseCode: (row.zatca_response_code as string | null) ?? null,
    zatcaResponseMessage: (row.zatca_response_message as string | null) ?? null,
    zatcaFailureCode: (row.zatca_failure_code as string | null) ?? null,
    zatcaRequestId: (row.zatca_request_id as string | null) ?? null,
    zatcaGlobalTransactionId: (row.zatca_global_transaction_id as string | null) ?? null,
    zatcaWarningCount: Number(row.zatca_warning_count ?? 0),
    zatcaErrorCount: Number(row.zatca_error_count ?? 0),
    zatcaResponsePayload: jsonToString(row.zatca_response_payload),
    clearedInvoicePayload: jsonToString(row.cleared_invoice_payload),
    signedXml: (row.signed_xml as string | null) ?? null,
    zatcaSubmissionDate: toDate(row.zatca_submission_date as string | null | undefined),
    notes: (row.notes as string | null) ?? null,
    terms: (row.terms as string | null) ?? null,
    isRecurring: Boolean(row.is_recurring ?? false),
    recurringDay: row.recurring_day != null ? Number(row.recurring_day) : null,
    nextDueDate: toDate(row.next_due_date as string | null | undefined),
    createdById: String(row.created_by_id ?? ''),
    createdAt: requireDate(String(row.created_at)),
    updatedAt: requireDate(String(row.updated_at)),
  }
}

export function mapInvoiceLineRow(row: Record<string, unknown>): InvoiceLineRecord {
  return {
    id: String(row.id),
    invoiceId: String(row.invoice_id),
    accountId: (row.account_id as string | null) ?? null,
    costCenterId: (row.cost_center_id as string | null) ?? null,
    inventoryItemId: (row.inventory_item_id as string | null) ?? null,
    itemName: (row.item_name as string | null) ?? null,
    projectService: (row.project_service as string | null) ?? null,
    className: (row.class_name as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    classId: (row.class_id as string | null) ?? null,
    description: String(row.description ?? ''),
    quantity: toNumber(row.quantity),
    unitPrice: toNumber(row.unit_price),
    taxRate: toNumber(row.tax_rate),
    taxRateId: (row.tax_rate_id as string | null) ?? null,
    amount: toNumber(row.amount),
  }
}

export function mapInvoiceAttachmentRow(row: Record<string, unknown>): InvoiceAttachmentRecord {
  return {
    id: String(row.id),
    invoiceId: String(row.invoice_id),
    filename: String(row.filename),
    originalFilename: String(row.original_filename ?? row.filename),
    mimeType: String(row.mime_type ?? 'application/octet-stream'),
    fileSize: Number(row.file_size ?? 0),
    storagePath: String(row.storage_path),
    uploadedById: (row.uploaded_by_id as string | null) ?? null,
    uploadedAt: requireDate(String(row.uploaded_at ?? row.created_at)),
  }
}

export function mapPaymentRow(row: Record<string, unknown>): PaymentRecord {
  return {
    id: String(row.id),
    paymentNo: String(row.payment_no),
    date: requireDate(String(row.date)),
    currency: normalizeCurrency(String(row.currency ?? DEFAULT_CURRENCY)),
    amount: toNumber(row.amount),
    method: String(row.method ?? 'BANK_TRANSFER'),
    reference: (row.reference as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    invoiceId: (row.invoice_id as string | null) ?? null,
    billId: (row.bill_id as string | null) ?? null,
    createdAt: requireDate(String(row.created_at)),
  }
}

export function mapInventoryItemRow(row: Record<string, unknown>): InventoryItemRecord {
  return {
    id: String(row.id),
    itemCode: String(row.item_code),
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    unit: String(row.unit ?? 'PCS'),
    costPrice: toNumber(row.cost_price),
    salePrice: toNumber(row.sale_price),
    quantity: toNumber(row.quantity),
    minQuantity: toNumber(row.min_quantity),
    isActive: Boolean(row.is_active ?? true),
    createdAt: requireDate(String(row.created_at)),
    updatedAt: requireDate(String(row.updated_at)),
  }
}

export function mapEmployeeRow(row: Record<string, unknown>): EmployeeRecord {
  return {
    id: String(row.id),
    employeeNo: String(row.employee_no),
    name: String(row.name),
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    department: (row.department as string | null) ?? null,
    position: (row.position as string | null) ?? null,
    joiningDate: requireDate(String(row.joining_date)),
    salary: toNumber(row.salary),
    salaryType: String(row.salary_type ?? 'MONTHLY'),
    bankAccount: (row.bank_account as string | null) ?? null,
    isActive: Boolean(row.is_active ?? true),
    createdAt: requireDate(String(row.created_at)),
    updatedAt: requireDate(String(row.updated_at)),
  }
}

export function mapCostCenterRow(row: Record<string, unknown>): CostCenterRecord {
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    type: String(row.type ?? 'PROJECT'),
    description: (row.description as string | null) ?? null,
    isActive: Boolean(row.is_active ?? true),
    metadata,
    createdAt: requireDate(String(row.created_at)),
    updatedAt: requireDate(String(row.updated_at)),
  }
}

export function mapTaxRateRow(row: Record<string, unknown>): TaxRateRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    rate: toNumber(row.rate),
    type: String(row.type ?? 'VAT'),
    category: String(row.category ?? row.type ?? 'VAT'),
    zatcaMapping: String(row.zatca_mapping ?? 'STANDARD_RATED'),
    isDefault: Boolean(row.is_default ?? false),
    isReverseCharge: Boolean(row.is_reverse_charge ?? false),
    isActive: Boolean(row.is_active ?? true),
    createdAt: requireDate(String(row.created_at)),
  }
}

export function mapPayrollLineRow(row: Record<string, unknown>): PayrollLineRecord {
  return {
    id: String(row.id),
    payrollId: String(row.payroll_id),
    type: String(row.type),
    description: String(row.description),
    amount: toNumber(row.amount),
  }
}

export function mapPayrollEntryRow(row: Record<string, unknown>): PayrollEntryRecord {
  return {
    id: String(row.id),
    payrollNo: String(row.payroll_no),
    employeeId: String(row.employee_id),
    period: String(row.period),
    periodStart: requireDate(String(row.period_start)),
    periodEnd: requireDate(String(row.period_end)),
    basicSalary: toNumber(row.basic_salary),
    allowances: toNumber(row.allowances),
    deductions: toNumber(row.deductions),
    taxAmount: toNumber(row.tax_amount),
    netSalary: toNumber(row.net_salary),
    status: String(row.status ?? 'DRAFT'),
    paidAt: toDate(row.paid_at as string | null | undefined),
    notes: (row.notes as string | null) ?? null,
    createdAt: requireDate(String(row.created_at)),
    updatedAt: requireDate(String(row.updated_at)),
  }
}

export function mapZatcaAuditLogRow(row: Record<string, unknown>): ZatcaAuditLogRecord {
  return {
    id: String(row.id),
    action: String(row.action),
    result: String(row.result),
    message: (row.message as string | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
    userName: (row.user_name as string | null) ?? null,
    companyName: (row.company_name as string | null) ?? null,
    invoiceId: (row.invoice_id as string | null) ?? null,
    metadata: jsonToString(row.metadata),
    createdAt: requireDate(String(row.created_at)),
  }
}
