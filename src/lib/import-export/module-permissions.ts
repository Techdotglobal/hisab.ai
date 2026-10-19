import type { PermissionKey } from '@/lib/permissions/catalog'

/**
 * Importing a module writes that module's records, so it needs the module's own write permission in
 * addition to `imports.run`. Someone allowed to run imports must not be able to create invoices
 * (or journals, payroll data, …) they could not create through the normal screens.
 */
const MODULE_WRITE_PERMISSION: Record<string, PermissionKey> = {
  customers: 'customers.edit',
  vendors: 'vendors.edit',
  inventory: 'inventory.edit',
  accounts: 'accounts.manage',
  'cost-centers': 'cost_centers.manage',
  employees: 'employees.manage',
  'tax-rates': 'tax.manage',
  'payment-terms': 'settings.manage',
  invoices: 'invoices.edit',
  bills: 'bills.edit',
  expenses: 'expenses.edit',
  'journal-entries': 'journals.edit',
  'sales-receipts': 'invoices.edit',
  'purchase-orders': 'bills.edit',
  'vendor-credits': 'bills.edit',
  estimates: 'invoices.edit',
  'customer-payments': 'payments.edit',
  'vendor-payments': 'payments.edit',
  'qb-projects': 'cost_centers.manage',
  'qb-budgets': 'budgets.manage',
  'qb-exchange-rates': 'settings.manage',
  'qb-classes': 'cost_centers.manage',
  'qb-departments': 'cost_centers.manage',
  'qb-locations': 'cost_centers.manage',
  'qb-employees': 'employees.manage',
  'qb-time-activities': 'invoices.edit',
  'qb-credit-memos': 'invoices.edit',
  'qb-bill-payments': 'payments.edit',
  'qb-deposits': 'banking.edit',
  'qb-transfers': 'banking.edit',
  'qb-inventory-adjustments': 'inventory.edit',
  'qb-attachments': 'settings.manage',
  'qb-recurring-transactions': 'settings.manage',
  'qb-tax-agencies': 'tax.manage',
  'qb-tax-configurations': 'tax.manage',
  'qb-preferences': 'settings.manage',
  'qb-fixed-assets': 'fixed_assets.manage',
}

/** Permissions required to import a module. Unknown modules fail closed to settings.manage. */
export function importPermissionsFor(moduleKey: string): PermissionKey[] {
  return ['imports.run', MODULE_WRITE_PERMISSION[moduleKey] ?? 'settings.manage']
}

export function mappedImportModules(): string[] {
  return Object.keys(MODULE_WRITE_PERMISSION)
}
