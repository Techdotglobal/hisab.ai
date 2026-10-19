// Route -> required permission policy. Single source of truth used by:
//   - scripts/rbac/apply-route-guards.mjs (one-off codemod that wraps handlers in guarded())
//   - tests/permissions/route-coverage.test.ts (asserts every handler is guarded or allow-listed)
//
// First matching rule wins. `read` applies to GET/HEAD, `write` to POST/PUT/PATCH/DELETE; `methods`
// overrides per HTTP method. A value may be an array = "any of these permissions".

const V = (a) => a

export const POLICY = [
  // --- explicit special cases first ---------------------------------------------------------
  { re: /^journal\/\[id\]\/(post|reverse|adjust)$/, read: 'journals.view', write: 'journals.post' },
  { re: /^journal\/\[id\]\/clone$/, read: 'journals.view', write: 'journals.edit' },
  { re: /^journal(\/|$)/, read: 'journals.view', write: 'journals.edit' },
  { re: /^(invoices|bills)\/\[id\]\/payment$/, read: 'payments.view', write: 'payments.edit' },
  { re: /^payments(\/|$)/, read: 'payments.view', write: 'payments.edit' },
  { re: /^credit-card-payments$/, read: 'payments.view', write: 'payments.edit' },
  { re: /^invoices\/\[id\]\/(credit-note|debit-note)$/, read: 'invoices.view', write: 'invoices.edit' },
  { re: /^zatca\/invoices\/\[id\]\//, read: 'invoices.view', write: 'invoices.edit' },
  { re: /^zatca\/(api-logs|dashboard|onboarding\/status|onboarding\/certificate-status)$/, read: 'invoices.view', write: 'integrations.manage' },
  { re: /^zatca(\/|$)/, read: 'integrations.manage', write: 'integrations.manage' },
  { re: /^trace\//, read: V(['invoices.view', 'bills.view', 'expenses.view']), write: V(['invoices.view', 'bills.view', 'expenses.view']) },
  { re: /^reports\/general-ledger$/, read: 'ledger.view', write: 'ledger.view' },
  { re: /^reports(\/|$)/, read: 'reports.view', write: 'reports.view' },
  { re: /^reporting\/export$/, read: 'reports.export', write: 'reports.export' },
  { re: /^reporting(\/|$)/, read: 'reports.view', write: 'reports.view' },
  { re: /^dashboard$/, read: 'dashboard.view', write: 'dashboard.view' },
  { re: /^import-export\/(history|sources|mapping-templates|quickbooks-snapshots|migration-sessions)(\/|$)/, read: 'imports.view', write: 'imports.run' },
  { re: /^import-export\/jobs\/\[jobId\](\/(errors|skips))?$/, read: 'imports.view', write: 'imports.run' },
  { re: /^import-export\/\[module\]\/(export|template)$/, read: 'imports.view', write: 'imports.view' },
  { re: /^import-export(\/|$)/, read: 'imports.view', write: 'imports.run' },
  { re: /^migration-wizard(\/|$)/, read: 'imports.view', write: 'imports.run' },
  { re: /^integrations(\/|$)/, read: 'imports.view', write: 'integrations.manage' },
  { re: /^platform\/(api-keys|webhooks|integrations|feature-flags)(\/|$)/, read: 'integrations.manage', write: 'integrations.manage' },
  { re: /^platform\/(notifications|search|localization|numbering)(\/|$)/, read: 'dashboard.view', write: 'platform.manage' },
  { re: /^platform(\/|$)/, read: 'platform.manage', write: 'platform.manage' },
  { re: /^custom-fields$/, read: 'dashboard.view', write: 'platform.manage' },
  { re: /^documents$/, read: 'dashboard.view', write: V(['invoices.edit', 'bills.edit', 'expenses.edit', 'platform.manage']) },
  { re: /^master-data\/\[table\]/, read: 'dashboard.view', write: V(['settings.manage', 'inventory.edit', 'cost_centers.manage']) },
  { re: /^product-master\/\[type\]$/, read: 'dashboard.view', write: 'inventory.edit' },
  { re: /^settings(\/|$)/, read: 'settings.view', write: 'settings.manage' },
  { re: /^currency(\/|$)/, read: 'settings.view', write: 'settings.manage' },
  { re: /^exchange-rates$/, read: 'settings.view', write: 'settings.manage' },
  { re: /^companies\/mine$/, read: 'dashboard.view', write: 'settings.manage' },
  { re: /^fiscal-periods(\/|$)/, read: 'accounts.view', write: 'fiscal_periods.manage' },
  { re: /^accounts(\/|$)/, read: 'accounts.view', write: 'accounts.manage' },
  { re: /^cost-centers(\/|$)/, read: 'cost_centers.view', write: 'cost_centers.manage' },
  { re: /^budgets$/, read: 'budgets.view', write: 'budgets.manage' },
  { re: /^fixed-assets$/, read: 'fixed_assets.view', write: 'fixed_assets.manage' },
  { re: /^tax\/calculate$/, read: 'tax.view', write: 'tax.view' },
  { re: /^tax(-configurations|-filings)?(\/|$)/, read: 'tax.view', write: 'tax.manage' },
  { re: /^banking(\/|$)/, read: 'banking.view', write: 'banking.edit' },
  { re: /^(inventory|stock-movements)(\/|$)/, read: 'inventory.view', write: 'inventory.edit' },
  { re: /^payroll\/\[id\]\/payslip$/, read: 'payroll.view', write: 'payroll.manage' },
  { re: /^(payroll|salary-structures)(\/|$)/, read: 'payroll.view', write: 'payroll.manage' },
  { re: /^(employees|attendance|employee-advances|employee-loans)(\/|$)/, read: 'employees.view', write: 'employees.manage' },
  { re: /^customers(\/|$)/, read: 'customers.view', write: 'customers.edit' },
  { re: /^vendors(\/|$)/, read: 'vendors.view', write: 'vendors.edit' },
  { re: /^invoices\/\[id\]$/, read: 'invoices.view', write: 'invoices.edit', methods: { PUT: ['invoices.edit', 'invoices.edit_drafts'] } },
  { re: /^(invoices|estimates|sales-orders|receipts|sales-receipts|refund-receipts|recurring-invoices|sales-transactions|billable-charges|time-activities)(\/|$)/, read: 'invoices.view', write: 'invoices.edit' },
  { re: /^(bills|purchase-orders|vendor-credits)(\/|$)/, read: 'bills.view', write: 'bills.edit' },
  { re: /^(expenses|expense-claims|expense-transactions|expense-categories|recurring-expenses)(\/|$)/, read: 'expenses.view', write: 'expenses.edit' },
  { re: /^recurring-transactions(\/|$)/, read: V(['invoices.view', 'bills.view', 'expenses.view']), write: V(['invoices.edit', 'bills.edit', 'expenses.edit']) },
  { re: /^workflows\/(templates|bindings|delegations)(\/|$)/, read: 'dashboard.view', write: 'workflows.manage' },
  // approvals inbox / submit: assignee checks live inside the handlers
  { re: /^workflows(\/|$)/, read: 'dashboard.view', write: 'dashboard.view' },
  { re: /^seed$/, read: 'settings.manage', write: 'settings.manage' },
]

/** Routes intentionally NOT wrapped. Each needs a reason; the coverage test enforces the list. */
export const EXEMPT = {
  'auth/logout': 'session teardown',
  'auth/register': 'public sign-up',
  'auth/me': 'returns the caller own profile only',
  health: 'liveness probe',
  live: 'liveness probe',
  ready: 'readiness probe',
  'integrations/quickbooks/callback': 'OAuth redirect; validated against signed state inside the handler',
  'integrations/quickbooks/webhook': 'verified by Intuit webhook signature inside the handler',
  users: 'permission-checked per method via requirePermission()',
  'users/[id]': 'permission-checked per method via requirePermission()',
  'users/[id]/access': 'permission-checked via requirePermission()',
  'users/[id]/grants': 'permission-checked via requirePermission()',
  'users/[id]/delegation': 'permission-checked via requirePermission()',
  'users/transfer-ownership': 'requireRole([OWNER])',
  roles: 'permission-checked via requirePermission()',
  'audit-logs': 'permission-checked via requirePermission()',
}

export function methodKind(method) {
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write'
}

export function resolvePolicy(routePath, method) {
  const rule = POLICY.find((r) => r.re.test(routePath))
  if (!rule) return null
  return rule.methods?.[method] ?? rule[methodKind(method)]
}
