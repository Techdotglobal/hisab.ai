/** Prisma-compatible entity shapes for repository layer. */

export interface CustomerRecord {
  id: string
  customerNo: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  streetAddress: string | null
  buildingNumber: string | null
  district: string | null
  city: string | null
  country: string | null
  postalCode: string | null
  taxId: string | null
  creditLimit: number
  paymentTerms: number
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  invoices?: { balance: number; status: string }[]
  outstandingBalance?: number
}

export interface VendorRecord {
  id: string
  vendorNo: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  country: string | null
  taxId: string | null
  paymentTerms: number
  isActive: boolean
  createdAt: Date
  updatedAt: Date
  bills?: { balance: number; status: string }[]
  outstandingBalance?: number
}

export interface ChartOfAccountRecord {
  id: string
  accountNo: string
  fullName: string
  name: string
  parentNo: string | null
  parentId: string | null
  accountType: string
  subType: string
  canonicalType: string | null
  normalBalance: string | null
  isActive: boolean
  description: string | null
  balance: number
  legacyId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface InvoiceAttachmentRecord {
  id: string
  invoiceId: string
  filename: string
  originalFilename: string
  mimeType: string
  fileSize: number
  storagePath: string
  uploadedById: string | null
  uploadedAt: Date
}

export interface InvoiceLineRecord {
  id: string
  invoiceId: string
  accountId: string | null
  costCenterId: string | null
  inventoryItemId?: string | null
  itemName: string | null
  projectService: string | null
  className: string | null
  projectId: string | null
  classId: string | null
  description: string
  quantity: number
  unitPrice: number
  taxRate: number
  taxRateId: string | null
  amount: number
  account?: ChartOfAccountRecord | null
}

export interface PaymentRecord {
  id: string
  paymentNo: string
  date: Date
  currency: string
  amount: number
  method: string
  reference: string | null
  notes: string | null
  invoiceId: string | null
  billId: string | null
  createdAt: Date
}

export interface InvoiceRecord {
  id: string
  invoiceNo: string
  invoiceUUID: string | null
  invoiceHash: string | null
  previousInvoiceHash: string | null
  invoiceType: string
  referencedInvoiceId: string | null
  referencedInvoiceNo?: string | null
  /** Parent tax invoice type, joined at read time for credit/debit notes. */
  referencedInvoiceType?: string | null
  customerId: string
  date: Date
  issueTime: string | null
  dueDate: Date
  expiryDate: Date | null
  currency: string
  status: string
  subtotal: number
  taxAmount: number
  total: number
  amountPaid: number
  balance: number
  taxCalculationMethod: string
  paymentTermId: string | null
  zatcaStatus: string
  clearanceStatus: string | null
  zatcaResponseCode: string | null
  zatcaResponseMessage: string | null
  zatcaFailureCode: string | null
  zatcaRequestId: string | null
  zatcaGlobalTransactionId: string | null
  zatcaWarningCount: number
  zatcaErrorCount: number
  zatcaResponsePayload: string | null
  clearedInvoicePayload: string | null
  signedXml: string | null
  zatcaSubmissionDate: Date | null
  notes: string | null
  terms: string | null
  isRecurring: boolean
  recurringDay: number | null
  nextDueDate: Date | null
  createdById: string
  createdAt: Date
  updatedAt: Date
  customer?: Partial<CustomerRecord> | { name: string; email?: string | null }
  lines?: InvoiceLineRecord[]
  payments?: PaymentRecord[]
  attachments?: InvoiceAttachmentRecord[]
  createdBy?: { name: string | null }
}

export interface InventoryItemRecord {
  id: string
  itemCode: string
  name: string
  description: string | null
  category: string | null
  unit: string
  costPrice: number
  salePrice: number
  quantity: number
  minQuantity: number
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export interface EmployeeRecord {
  id: string
  employeeNo: string
  name: string
  email: string | null
  phone: string | null
  department: string | null
  position: string | null
  joiningDate: Date
  salary: number
  salaryType: string
  bankAccount: string | null
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export interface CostCenterRecord {
  id: string
  code: string
  name: string
  type: string
  description: string | null
  isActive: boolean
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface TaxRateRecord {
  id: string
  name: string
  rate: number
  type: string
  category: string
  zatcaMapping: string
  isDefault: boolean
  isReverseCharge: boolean
  isActive: boolean
  createdAt: Date
}

export interface PayrollLineRecord {
  id: string
  payrollId: string
  type: string
  description: string
  amount: number
}

export interface PayrollEntryRecord {
  id: string
  payrollNo: string
  employeeId: string
  period: string
  periodStart: Date
  periodEnd: Date
  basicSalary: number
  allowances: number
  deductions: number
  taxAmount: number
  netSalary: number
  status: string
  paidAt: Date | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
  employee?: Partial<EmployeeRecord> | { name: string; employeeNo?: string; department?: string | null }
  lines?: PayrollLineRecord[]
}

export interface ZatcaAuditLogRecord {
  id: string
  action: string
  result: string
  message: string | null
  userId: string | null
  userName: string | null
  companyName: string | null
  invoiceId: string | null
  metadata: string | null
  createdAt: Date
}

export type DashboardPayload = Record<string, unknown>
