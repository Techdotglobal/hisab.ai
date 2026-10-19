import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CompanyRole } from '../../src/lib/db/types'
import {
  ALL_PERMISSIONS,
  NON_REDELEGABLE,
  ROLE_BASELINES,
  hasPermission,
  resolveEffectiveAccess,
  scopeAllows,
  type PermissionGrant,
  type PermissionKey,
} from '../../src/lib/permissions/catalog'
import {
  AccessDeniedError,
  analyzeAccess,
  assertCanAssignRole,
  assertCanChangeGrant,
  assertCanCreateUser,
  assertCanDeactivateUser,
  assertCanEditUser,
  assertCanManageDelegations,
  authorityOf,
  normalizeDelegation,
  type Delegation,
  type Principal,
  type TargetInfo,
} from '../../src/lib/permissions/delegation'

function principal(id: string, role: CompanyRole, grants: PermissionKey[] = [], delegation: Delegation | null = null): Principal {
  return { userId: id, role, access: resolveEffectiveAccess(role, grants.map((permission) => ({ permission }))), delegation }
}
function target(id: string, role: CompanyRole, grants: PermissionKey[] = []): TargetInfo {
  return { userId: id, role, access: resolveEffectiveAccess(role, grants.map((permission) => ({ permission }))) }
}
function denied(fn: () => void, reason?: string) {
  assert.throws(fn, (e: unknown) => e instanceof AccessDeniedError && (!reason || e.reason === reason))
}

describe('effective permission resolution', () => {
  it('OWNER holds every permission', () => {
    const a = resolveEffectiveAccess('OWNER', [])
    for (const k of ALL_PERMISSIONS) assert.ok(hasPermission(a, k))
  })
  it('nothing is granted by default beyond the role baseline', () => {
    const a = resolveEffectiveAccess('EMPLOYEE', [])
    assert.equal(hasPermission(a, 'payroll.view'), false)
    assert.equal(hasPermission(a, 'ledger.view'), false)
    assert.equal(hasPermission(a, 'permissions.manage'), false)
  })
  it('an individual grant adds exactly that permission and nothing else', () => {
    const a = resolveEffectiveAccess('AUDITOR', [{ permission: 'invoices.edit_drafts' }])
    assert.ok(hasPermission(a, 'invoices.edit_drafts'))
    assert.equal(hasPermission(a, 'invoices.edit'), false)
    assert.equal(a.permissions.get('invoices.edit_drafts')!.sources[0], 'grant')
  })
  it('role and grant sources are reported separately', () => {
    const a = resolveEffectiveAccess('ACCOUNTANT', [{ permission: 'invoices.view' }])
    assert.deepEqual(a.permissions.get('invoices.view')!.sources, ['role', 'grant'])
  })
  it('revoking (omitting) the grant removes access where no other source exists', () => {
    const withGrant = resolveEffectiveAccess('EMPLOYEE', [{ permission: 'ledger.view' }])
    const without = resolveEffectiveAccess('EMPLOYEE', [])
    assert.ok(hasPermission(withGrant, 'ledger.view'))
    assert.equal(hasPermission(without, 'ledger.view'), false)
  })
  it('scoped grants only cover their cost centers; role access stays company-wide', () => {
    const grant: PermissionGrant = { permission: 'expenses.view', scope: { costCenterIds: ['cc1'] } }
    const a = resolveEffectiveAccess('AUDITOR', [{ permission: 'payroll.view', scope: { costCenterIds: ['cc1'] } }, grant])
    assert.ok(scopeAllows(a, 'payroll.view', 'cc1'))
    assert.equal(scopeAllows(a, 'payroll.view', 'cc2'), false)
    assert.equal(scopeAllows(a, 'payroll.view', null), false)
    // expenses.view is role-derived for AUDITOR -> unscoped
    assert.ok(scopeAllows(a, 'expenses.view', 'cc2'))
  })
  it('admin keeps day-to-day user management but not permissions.manage / roles.manage', () => {
    const a = resolveEffectiveAccess('ADMIN', [])
    assert.ok(hasPermission(a, 'users.create'))
    for (const k of NON_REDELEGABLE) assert.equal(hasPermission(a, k), false)
  })
  it('only the owner baseline contains permissions.manage', () => {
    for (const role of Object.keys(ROLE_BASELINES) as CompanyRole[]) {
      assert.equal(ROLE_BASELINES[role].includes('permissions.manage'), role === 'OWNER')
    }
  })
  it('write access is not available to AUDITOR or EMPLOYEE for accounting records', () => {
    for (const role of ['AUDITOR', 'EMPLOYEE'] as CompanyRole[]) {
      const a = resolveEffectiveAccess(role, [])
      for (const k of ['journals.post', 'invoices.edit', 'bills.edit', 'payments.edit', 'settings.manage'] as PermissionKey[]) {
        assert.equal(hasPermission(a, k), false, `${role} ${k}`)
      }
    }
  })
})

describe('delegation scenarios', () => {
  const owner = principal('owner', 'OWNER')
  const accountant = target('acc', 'ACCOUNTANT')
  const employee = target('emp', 'EMPLOYEE')
  const auditor = target('aud', 'AUDITOR')

  // Scenario A: view-only access manager
  const viewer = principal('v', 'EMPLOYEE', ['users.view', 'users.view_permissions', 'roles.view'], { manageableRoles: [], delegable: [] })
  it('A: a view-only access manager can inspect but cannot change anything', () => {
    assert.ok(hasPermission(viewer.access, 'users.view_permissions'))
    denied(() => assertCanEditUser(viewer, employee), 'missing_capability')
    denied(() => assertCanDeactivateUser(viewer, employee), 'missing_capability')
    denied(() => assertCanAssignRole(viewer, employee, 'AUDITOR'), 'missing_capability')
    denied(() => assertCanChangeGrant(viewer, employee, 'ledger.view'), 'missing_capability')
    denied(() => assertCanCreateUser(viewer, 'EMPLOYEE'), 'missing_capability')
  })

  // Scenario B: user administrator (no role assignment, no grants)
  const userAdmin = principal('ua', 'EMPLOYEE', ['users.view', 'users.create', 'users.edit', 'users.deactivate'], {
    manageableRoles: ['EMPLOYEE', 'AUDITOR'],
    delegable: [],
  })
  it('B: a user administrator manages ordinary users but cannot assign roles or grant permissions', () => {
    assertCanCreateUser(userAdmin, 'EMPLOYEE')
    assertCanEditUser(userAdmin, employee)
    assertCanDeactivateUser(userAdmin, auditor)
    denied(() => assertCanAssignRole(userAdmin, employee, 'AUDITOR'), 'missing_capability')
    denied(() => assertCanChangeGrant(userAdmin, employee, 'ledger.view'), 'missing_capability')
  })
  it('B: cannot create or edit users outside the roles the owner allowed', () => {
    denied(() => assertCanCreateUser(userAdmin, 'ADMIN'), 'role_not_manageable')
    denied(() => assertCanEditUser(userAdmin, accountant), 'role_not_manageable')
  })

  // Scenario C: permission manager
  const permManager = principal('pm', 'EMPLOYEE', ['users.view', 'users.view_permissions', 'roles.assign', 'permissions.manage'], {
    manageableRoles: ['EMPLOYEE', 'AUDITOR'],
    delegable: ['ledger.view', 'reports.view'],
  })
  it('C: a permission manager can grant only within the delegation limit', () => {
    assertCanChangeGrant(permManager, employee, 'ledger.view')
    denied(() => assertCanChangeGrant(permManager, employee, 'payroll.view'), 'permission_not_delegable')
    denied(() => assertCanChangeGrant(permManager, employee, 'journals.post'), 'permission_not_delegable')
  })
  it('C: can never hand out permissions.manage / roles.manage, even if they sit in a stored delegation', () => {
    const sneaky = principal('s', 'EMPLOYEE', ['permissions.manage'], {
      manageableRoles: ['EMPLOYEE'],
      delegable: ['permissions.manage', 'roles.manage', 'ledger.view'] as PermissionKey[],
    })
    for (const k of NON_REDELEGABLE) denied(() => assertCanChangeGrant(sneaky, employee, k), 'permission_not_redelegable')
    assert.equal(authorityOf(sneaky).delegable.has('permissions.manage'), false)
  })
  it('C: role assignment is limited to manageable roles and never Owner', () => {
    assertCanAssignRole(permManager, employee, 'AUDITOR')
    denied(() => assertCanAssignRole(permManager, employee, 'ADMIN'), 'role_not_manageable')
    denied(() => assertCanAssignRole(permManager, employee, 'OWNER' as CompanyRole), 'owner_role_forbidden')
    denied(() => assertCanAssignRole(owner, employee, 'OWNER' as CompanyRole), 'owner_role_forbidden')
    denied(() => assertCanAssignRole(owner, employee, 'SUPER_ADMIN' as CompanyRole), 'owner_role_forbidden')
  })

  // Scenario D: combined delegated administrator
  const combined = principal(
    'd',
    'EMPLOYEE',
    ['users.view', 'users.create', 'users.edit', 'users.deactivate', 'users.view_permissions', 'roles.assign', 'permissions.manage'],
    { manageableRoles: ['EMPLOYEE', 'AUDITOR', 'MANAGER'], delegable: ['ledger.view', 'reports.view'] },
  )
  it('D: combined admin works within scope and has no financial or settings access', () => {
    assertCanCreateUser(combined, 'MANAGER')
    assertCanChangeGrant(combined, employee, 'reports.view')
    for (const k of ['journals.view', 'invoices.view', 'payroll.view', 'settings.manage', 'ledger.view'] as PermissionKey[]) {
      assert.equal(hasPermission(combined.access, k), false, k)
    }
  })

  it('cannot promote themselves', () => {
    const self = target('d', 'EMPLOYEE', ['users.view', 'permissions.manage'])
    denied(() => assertCanChangeGrant(combined, self, 'ledger.view'), 'self_modification')
    denied(() => assertCanAssignRole(combined, self, 'MANAGER'), 'self_modification')
  })
  it('cannot touch the owner', () => {
    const o = target('owner', 'OWNER')
    denied(() => assertCanEditUser(combined, o), 'target_is_owner')
    denied(() => assertCanDeactivateUser(combined, o), 'target_is_owner')
    denied(() => assertCanChangeGrant(combined, o, 'ledger.view'), 'target_is_owner')
    denied(() => assertCanEditUser(owner, o), 'target_is_owner')
  })
  it('cannot edit (e.g. reset the password of) a user whose access exceeds the delegation', () => {
    const privilegedEmployee = target('pe', 'EMPLOYEE', ['payroll.manage'])
    denied(() => assertCanEditUser(userAdmin, privilegedEmployee), 'target_exceeds_authority')
  })
  it('revoking the delegation (no record) removes all delegated authority', () => {
    const revoked = principal('d', 'EMPLOYEE', ['users.view', 'users.edit', 'permissions.manage'], null)
    denied(() => assertCanEditUser(revoked, employee), 'role_not_manageable')
    denied(() => assertCanChangeGrant(revoked, employee, 'ledger.view'), 'role_not_manageable')
  })
  it('owner can grant any permission to a non-owner but delegations are owner-only', () => {
    assertCanChangeGrant(owner, employee, 'permissions.manage')
    assertCanManageDelegations(owner)
    denied(() => assertCanManageDelegations(combined), 'missing_capability')
    denied(() => assertCanManageDelegations(principal('a', 'ADMIN')), 'missing_capability')
  })
  it('legacy ADMIN keeps user management of non-owner roles but cannot grant individual permissions', () => {
    const admin = principal('adm', 'ADMIN')
    assertCanCreateUser(admin, 'ACCOUNTANT')
    assertCanEditUser(admin, accountant)
    assertCanAssignRole(admin, employee, 'MANAGER')
    denied(() => assertCanChangeGrant(admin, employee, 'ledger.view'), 'missing_capability')
    denied(() => assertCanEditUser(admin, target('owner', 'OWNER')), 'target_is_owner')
  })
  it('an ADMIN with a delegation record is restricted to it', () => {
    const limited = principal('adm', 'ADMIN', [], { manageableRoles: ['EMPLOYEE'], delegable: [] })
    denied(() => assertCanEditUser(limited, accountant), 'role_not_manageable')
    assertCanEditUser(limited, employee)
  })
  it('an accountant has no access administration', () => {
    const a = principal('acc', 'ACCOUNTANT')
    denied(() => assertCanCreateUser(a, 'EMPLOYEE'), 'missing_capability')
    denied(() => assertCanChangeGrant(a, employee, 'ledger.view'), 'missing_capability')
  })
})

describe('normalizeDelegation', () => {
  it('drops OWNER, unknown roles, unknown and non-redelegable permissions', () => {
    const d = normalizeDelegation({
      manageableRoles: ['OWNER', 'EMPLOYEE', 'bogus', 'EMPLOYEE'],
      delegable: ['ledger.view', 'permissions.manage', 'roles.manage', 'nope'],
    })
    assert.deepEqual(d.manageableRoles, ['EMPLOYEE'])
    assert.deepEqual(d.delegable, ['ledger.view'])
  })
})

describe('analyzeAccess', () => {
  it('flags redundant grants, missing view, and segregation conflicts', () => {
    const a = resolveEffectiveAccess('ACCOUNTANT', [{ permission: 'invoices.view' }])
    const codes = analyzeAccess(a, ['invoices.view']).map((w) => w.code)
    assert.ok(codes.includes('redundant_grant'))
    assert.ok(codes.includes('segregation_journals'))
    const b = resolveEffectiveAccess('EMPLOYEE', [{ permission: 'journals.post' }])
    assert.ok(analyzeAccess(b, ['journals.post']).some((w) => w.code === 'edit_without_view'))
  })
})
