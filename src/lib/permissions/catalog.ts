/**
 * Permission catalog + role baselines. Pure data/logic — no server imports, so it is unit-testable
 * and importable from client components (e.g. the access-management UI).
 *
 * Policy (see docs/rbac-policy.md):
 *  - Allow-only model. There are no explicit denies.
 *  - effective = role baseline ∪ active individual grants. Nothing is granted by default.
 *  - OWNER holds every permission and is protected from modification by anyone else.
 *  - Access-administration permissions are separate from financial permissions, so a delegated
 *    manager can administer access without seeing accounting data (and vice-versa).
 */

import type { CompanyRole } from '@/lib/db/types'

export interface PermissionDef {
  key: string
  module: string
  label: string
  description: string
}

const p = (key: string, module: string, label: string, description: string): PermissionDef => ({
  key,
  module,
  label,
  description,
})

export const PERMISSION_DEFS = [
  // --- Access administration ---------------------------------------------------------------
  p('users.view', 'Users & access', 'View user directory', 'See the list of company users.'),
  p('users.create', 'Users & access', 'Create users', 'Create or invite new users.'),
  p('users.edit', 'Users & access', 'Edit users', 'Edit names and reset passwords of ordinary users.'),
  p('users.deactivate', 'Users & access', 'Deactivate users', 'Deactivate, reactivate or remove users.'),
  p('users.view_permissions', 'Users & access', 'View user permissions', "Inspect any user's effective access."),
  p('permissions.manage', 'Users & access', 'Manage permissions', 'Grant or revoke individual permissions within the delegation limit set by the owner.'),
  p('roles.view', 'Users & access', 'View roles', 'See roles and the permissions attached to them.'),
  p('roles.manage', 'Users & access', 'Manage roles', 'Change role definitions (owner only; not delegable).'),
  p('roles.assign', 'Users & access', 'Assign roles', 'Change the role of a user within the delegation limit.'),
  p('audit_logs.view', 'Users & access', 'View audit log', 'Search the audit log.'),
  p('audit_logs.export', 'Users & access', 'Export audit log', 'Export audit log entries.'),

  // --- Financial and operational modules ---------------------------------------------------
  p('dashboard.view', 'Dashboard', 'View dashboard', 'See dashboard KPIs.'),
  p('reports.view', 'Reports', 'View financial reports', 'Profit & Loss, Balance Sheet, Cash Flow, Trial Balance, aged reports.'),
  p('ledger.view', 'Reports', 'View general ledger', 'See ledger lines and account balance drill-downs.'),
  p('reports.export', 'Reports', 'Export reports', 'Export reports to CSV/XLSX/PDF.'),
  p('accounts.view', 'Accounting', 'View chart of accounts', 'See accounts and balances.'),
  p('accounts.manage', 'Accounting', 'Manage chart of accounts', 'Create or change accounts.'),
  p('journals.view', 'Accounting', 'View journal entries', 'See journal entries.'),
  p('journals.edit', 'Accounting', 'Edit journal entries', 'Create and edit draft journal entries.'),
  p('journals.post', 'Accounting', 'Post / reverse journals', 'Post, adjust and reverse journal entries.'),
  p('fiscal_periods.manage', 'Accounting', 'Manage fiscal periods', 'Close periods and years.'),
  p('invoices.view', 'Sales', 'View sales documents', 'Invoices, estimates, sales orders, receipts.'),
  p('invoices.edit', 'Sales', 'Edit sales documents', 'Create/edit sales documents.'),
  p('invoices.edit_drafts', 'Sales', 'Edit draft/imported invoices', 'Edit only draft or imported unsubmitted invoices.'),
  p('customers.view', 'Sales', 'View customers', 'See customers.'),
  p('customers.edit', 'Sales', 'Edit customers', 'Create/edit customers.'),
  p('bills.view', 'Purchases', 'View purchase documents', 'Bills, purchase orders, vendor credits.'),
  p('bills.edit', 'Purchases', 'Edit purchase documents', 'Create/edit purchase documents.'),
  p('vendors.view', 'Purchases', 'View vendors', 'See vendors.'),
  p('vendors.edit', 'Purchases', 'Edit vendors', 'Create/edit vendors.'),
  p('expenses.view', 'Expenses', 'View expenses', 'Expenses, claims, recurring expenses.'),
  p('expenses.edit', 'Expenses', 'Edit expenses', 'Create/edit expenses.'),
  p('payments.view', 'Payments', 'View payments', 'See payments and allocations.'),
  p('payments.edit', 'Payments', 'Record payments', 'Record and allocate payments.'),
  p('banking.view', 'Banking', 'View banking', 'Bank accounts, transactions, reconciliations.'),
  p('banking.edit', 'Banking', 'Manage banking', 'Create/modify banking records.'),
  p('inventory.view', 'Inventory', 'View inventory', 'See inventory.'),
  p('inventory.edit', 'Inventory', 'Manage inventory', 'Change inventory.'),
  p('tax.view', 'Tax', 'View tax', 'Tax configuration, filings and reports.'),
  p('tax.manage', 'Tax', 'Manage tax', 'Change tax configuration, file returns.'),
  p('cost_centers.view', 'Cost centers', 'View cost centers', 'Departments, branches, projects.'),
  p('cost_centers.manage', 'Cost centers', 'Manage cost centers', 'Create/modify cost centers.'),
  p('budgets.view', 'Budgets', 'View budgets', 'See budgets.'),
  p('budgets.manage', 'Budgets', 'Manage budgets', 'Change budgets.'),
  p('fixed_assets.view', 'Fixed assets', 'View fixed assets', 'See fixed assets.'),
  p('fixed_assets.manage', 'Fixed assets', 'Manage fixed assets', 'Change fixed assets.'),
  p('employees.view', 'HR & payroll', 'View employees', 'See employee records.'),
  p('employees.manage', 'HR & payroll', 'Manage employees', 'Change employee records.'),
  p('payroll.view', 'HR & payroll', 'View payroll', 'See payroll runs and payslips.'),
  p('payroll.manage', 'HR & payroll', 'Manage payroll', 'Run, edit and approve payroll.'),
  p('imports.run', 'Import / export', 'Run imports and migrations', 'Run CSV/QuickBooks imports.'),
  p('imports.view', 'Import / export', 'View import history', 'See import history and exports.'),
  p('settings.view', 'Settings', 'View settings', 'See company settings.'),
  p('settings.manage', 'Settings', 'Manage settings', 'Change company settings.'),
  p('integrations.manage', 'Settings', 'Manage integrations', 'QuickBooks, ZATCA, API keys, webhooks.'),
  p('workflows.manage', 'Workflows', 'Manage workflows', 'Templates, delegations and approvals.'),
  p('platform.manage', 'Platform', 'Manage platform features', 'Custom fields, documents, automation.'),
] as const

export type PermissionKey = (typeof PERMISSION_DEFS)[number]['key']

export const ALL_PERMISSIONS: PermissionKey[] = PERMISSION_DEFS.map((d) => d.key)

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && (ALL_PERMISSIONS as string[]).includes(value)
}

export function permissionDef(key: PermissionKey): PermissionDef {
  return PERMISSION_DEFS.find((d) => d.key === key)!
}

/**
 * Permissions that control access administration itself. `permissions.manage` and `roles.manage`
 * can never be delegated onward: only the OWNER can hold them in a delegation, and a delegate can
 * never hand them to someone else. This is what stops a delegate from promoting themselves.
 */
export const NON_REDELEGABLE: PermissionKey[] = ['permissions.manage', 'roles.manage']

export const ACCESS_ADMIN_PERMISSIONS: PermissionKey[] = [
  'users.view', 'users.create', 'users.edit', 'users.deactivate', 'users.view_permissions',
  'permissions.manage', 'roles.view', 'roles.manage', 'roles.assign', 'audit_logs.view', 'audit_logs.export',
]

const ACCOUNTANT_PERMS: PermissionKey[] = [
  'dashboard.view', 'reports.view', 'ledger.view', 'reports.export', 'accounts.view', 'accounts.manage',
  'journals.view', 'journals.edit', 'journals.post', 'fiscal_periods.manage',
  'invoices.view', 'invoices.edit', 'invoices.edit_drafts', 'customers.view', 'customers.edit',
  'bills.view', 'bills.edit', 'vendors.view', 'vendors.edit', 'expenses.view', 'expenses.edit',
  'payments.view', 'payments.edit', 'banking.view', 'banking.edit', 'inventory.view', 'inventory.edit',
  'tax.view', 'tax.manage', 'cost_centers.view', 'cost_centers.manage', 'budgets.view', 'budgets.manage',
  'fixed_assets.view', 'fixed_assets.manage', 'employees.view', 'payroll.view',
  'imports.run', 'imports.view', 'settings.view', 'workflows.manage', 'platform.manage', 'roles.view',
]

const VIEW_ONLY_PERMS: PermissionKey[] = ALL_PERMISSIONS.filter(
  (k) => k.endsWith('.view') && !ACCESS_ADMIN_PERMISSIONS.includes(k) && k !== 'payroll.view' && k !== 'employees.view',
)

/**
 * Role baselines. They intentionally mirror what the previous `requireRole` checks allowed
 * (OWNER/ADMIN/ACCOUNTANT/MANAGER could mutate, AUDITOR could read) so existing users keep working;
 * what changes is that writes are no longer open to EMPLOYEE/AUDITOR and access administration is
 * split into separately grantable capabilities.
 */
export const ROLE_BASELINES: Record<CompanyRole, PermissionKey[]> = {
  OWNER: [...ALL_PERMISSIONS],
  // ADMIN keeps day-to-day user management (as before) but not permissions.manage / roles.manage;
  // those are delegated only by the owner.
  ADMIN: ALL_PERMISSIONS.filter((k) => !NON_REDELEGABLE.includes(k)),
  ACCOUNTANT: ACCOUNTANT_PERMS,
  MANAGER: ACCOUNTANT_PERMS.filter(
    (k) => !['journals.post', 'fiscal_periods.manage', 'accounts.manage', 'tax.manage', 'platform.manage'].includes(k),
  ),
  EMPLOYEE: ['dashboard.view', 'expenses.view', 'expenses.edit'],
  AUDITOR: [...VIEW_ONLY_PERMS, 'ledger.view', 'reports.export', 'audit_logs.view'],
}

export function isCompanyRole(value: unknown): value is CompanyRole {
  return typeof value === 'string' && value in ROLE_BASELINES
}

// ------------------------------------------------------------------------------------------------
// Resolution
// ------------------------------------------------------------------------------------------------

/** Optional restriction on an individually granted permission. */
export interface PermissionScope {
  costCenterIds?: string[]
}

export interface PermissionGrant {
  permission: PermissionKey
  scope?: PermissionScope | null
  grantedBy?: string | null
  grantedAt?: string | null
  reason?: string | null
}

export interface EffectivePermission {
  permission: PermissionKey
  /** 'role' = inherited, 'grant' = individual, 'owner' = owner-protected. */
  sources: Array<'role' | 'grant' | 'owner'>
  scope: PermissionScope | null
}

export interface EffectiveAccess {
  role: CompanyRole
  permissions: Map<PermissionKey, EffectivePermission>
}

/**
 * role baseline ∪ individual grants. A role-derived permission is always unscoped (company-wide),
 * so a scoped individual grant never narrows it; scope only restricts permissions that exist
 * solely through a grant. Revoked grants must be filtered out by the caller.
 */
export function resolveEffectiveAccess(role: CompanyRole, grants: PermissionGrant[]): EffectiveAccess {
  const permissions = new Map<PermissionKey, EffectivePermission>()
  const baseline = ROLE_BASELINES[role] ?? []
  for (const permission of baseline) {
    permissions.set(permission, {
      permission,
      sources: [role === 'OWNER' ? 'owner' : 'role'],
      scope: null,
    })
  }
  for (const grant of grants) {
    const existing = permissions.get(grant.permission)
    if (existing) {
      if (!existing.sources.includes('grant')) existing.sources.push('grant')
      continue
    }
    permissions.set(grant.permission, {
      permission: grant.permission,
      sources: ['grant'],
      scope: grant.scope && Object.keys(grant.scope).length ? grant.scope : null,
    })
  }
  return { role, permissions }
}

export function hasPermission(access: EffectiveAccess, permission: PermissionKey): boolean {
  return access.permissions.has(permission)
}

/** Does the permission cover a record in the given cost center? Unscoped = company-wide. */
export function scopeAllows(access: EffectiveAccess, permission: PermissionKey, costCenterId: string | null): boolean {
  const entry = access.permissions.get(permission)
  if (!entry) return false
  const allowed = entry.scope?.costCenterIds
  if (!allowed) return true
  return costCenterId !== null && allowed.includes(costCenterId)
}

export function listEffective(access: EffectiveAccess): EffectivePermission[] {
  return [...access.permissions.values()]
}
