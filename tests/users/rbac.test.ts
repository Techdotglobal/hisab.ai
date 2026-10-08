import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  ASSIGNABLE_NON_OWNER_ROLES,
  OwnershipGuardError,
  fromDisplayRole,
  publicRole,
  toCompanyRole,
} from '../../src/lib/supabase/auth-users'

function src(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

describe('role display mapping (Owner -> Super Admin, Auditor -> Viewer)', () => {
  it('OWNER displays as Super Admin, the same convention already used for Auditor/Viewer', () => {
    assert.equal(publicRole('OWNER'), 'SUPER_ADMIN')
    assert.equal(publicRole('AUDITOR'), 'VIEWER')
  })

  it('other roles pass through unchanged', () => {
    assert.equal(publicRole('ADMIN'), 'ADMIN')
    assert.equal(publicRole('ACCOUNTANT'), 'ACCOUNTANT')
    assert.equal(publicRole('MANAGER'), 'MANAGER')
  })

  it('defaults to Accountant when no role is stored', () => {
    assert.equal(publicRole(null), 'ACCOUNTANT')
    assert.equal(publicRole(undefined), 'ACCOUNTANT')
  })
})

describe('toCompanyRole: registration can still produce an Owner row directly', () => {
  it('accepts OWNER — new-company signup relies on this', () => {
    assert.equal(toCompanyRole('OWNER'), 'OWNER')
  })

  it('accepts the other real company_role values unchanged', () => {
    for (const role of ['ADMIN', 'ACCOUNTANT', 'MANAGER', 'EMPLOYEE']) {
      assert.equal(toCompanyRole(role), role)
    }
  })

  it('never turns a display-only label into OWNER: SUPER_ADMIN falls through to the safe default', () => {
    assert.equal(toCompanyRole('SUPER_ADMIN'), 'AUDITOR')
  })

  it('unknown input defaults to AUDITOR, never OWNER', () => {
    assert.equal(toCompanyRole('nonsense'), 'AUDITOR')
    assert.equal(toCompanyRole(null), 'AUDITOR')
  })
})

describe('fromDisplayRole: the only path user-management forms may use to pick a role', () => {
  it('maps the Viewer label to the stored Auditor role', () => {
    assert.equal(fromDisplayRole('VIEWER'), 'AUDITOR')
  })

  it('passes real role values through unchanged', () => {
    for (const role of ASSIGNABLE_NON_OWNER_ROLES) {
      if (role === 'AUDITOR') continue
      assert.equal(fromDisplayRole(role), role)
    }
  })

  it('rejects OWNER and SUPER_ADMIN — ownership is never settable through a role field', () => {
    assert.throws(() => fromDisplayRole('OWNER'), OwnershipGuardError)
    assert.throws(() => fromDisplayRole('SUPER_ADMIN'), OwnershipGuardError)
  })

  it('rejects unknown roles instead of silently defaulting', () => {
    assert.throws(() => fromDisplayRole('NOT_A_ROLE'))
  })
})

describe('ASSIGNABLE_NON_OWNER_ROLES never includes Owner', () => {
  it('excludes OWNER', () => {
    assert.equal(ASSIGNABLE_NON_OWNER_ROLES.includes('OWNER' as never), false)
  })
})

describe('server-side enforcement — create and update user', () => {
  const authUsers = src('src/lib/supabase/auth-users.ts')

  it('createAppUser rejects an Owner role before any auth user is created', () => {
    const guardAt = authUsers.indexOf("input.role === 'OWNER' || input.role === 'SUPER_ADMIN'")
    const createAt = authUsers.indexOf('admin.auth.admin.createUser(')
    assert.ok(guardAt > 0 && createAt > guardAt, 'the OWNER guard must run before createUser')
  })

  it('updateAppUser reads the actual stored role, not the display string in auth metadata, before deciding anything', () => {
    assert.match(
      authUsers,
      /const currentRole = \(currentMembership\?\.role as CompanyRole \| undefined\) \?\? 'ACCOUNTANT'/,
    )
  })

  it('updateAppUser blocks a role or deactivation change on a row that is currently Owner', () => {
    assert.match(
      authUsers,
      /if \(currentRole === 'OWNER' && \(input\.role !== undefined \|\| input\.isActive === false\)\) \{\n\s*throw new OwnershipGuardError\(\)/,
    )
  })

  it('deleteAppUser takes companyId and refuses to delete an Owner', () => {
    assert.match(authUsers, /export async function deleteAppUser\(userId: string, companyId: string\)/)
    assert.match(authUsers, /if \(membership\?\.role === 'OWNER'\) \{\n\s*throw new OwnershipGuardError/)
  })

  it('transferCompanyOwnership calls the migration 080 Postgres function, not a plain row update', () => {
    assert.match(authUsers, /admin\.rpc\('transfer_company_ownership', \{/)
  })
})

describe('route-level authorization', () => {
  const usersRoute = src('src/app/api/users/route.ts')
  const userIdRoute = src('src/app/api/users/[id]/route.ts')
  const transferRoute = src('src/app/api/users/transfer-ownership/route.ts')

  it('list and create users require Owner or Admin', () => {
    const matches = usersRoute.match(/requireRole\(\['OWNER', 'ADMIN'\]\)/g) ?? []
    assert.equal(matches.length, 2)
  })

  it('edit and delete users require Owner or Admin', () => {
    const matches = userIdRoute.match(/requireRole\(\['OWNER', 'ADMIN'\]\)/g) ?? []
    assert.equal(matches.length, 2)
  })

  it('transfer-ownership requires Owner ONLY — Admin cannot call it', () => {
    assert.match(transferRoute, /requireRole\(\['OWNER'\]\)/)
    assert.doesNotMatch(transferRoute, /requireRole\(\['OWNER', 'ADMIN'\]\)/)
  })

  it('transfer-ownership rejects transferring to yourself', () => {
    assert.match(transferRoute, /body\.newOwnerUserId === session\.id/)
  })

  it('transfer-ownership normalizes the submitted role through fromDisplayRole, not a raw string', () => {
    assert.match(transferRoute, /fromDisplayRole\(body\.previousOwnerNewRole\)/)
  })

  it('delete route passes the acting company id so ownership can be checked', () => {
    assert.match(userIdRoute, /deleteAppUser\(id, currentUser\.companyId\)/)
  })
})

describe('authzErrorResponse maps the ownership guard to 400, not 500', () => {
  it('handles OwnershipGuardError', () => {
    const authz = src('src/lib/authz.ts')
    assert.match(authz, /error instanceof OwnershipGuardError/)
    assert.match(authz, /status: 400 \}\)\n  \}\n  return Response\.json\(\{ error: serializeAuthzError/)
  })
})

describe('migration 080: transfer_company_ownership invariants', () => {
  const migration = src('supabase/migrations/080_transfer_company_ownership.sql')

  it('refuses to set the previous owner back to OWNER', () => {
    assert.match(migration, /IF p_previous_owner_new_role = 'OWNER' THEN/)
  })

  it('locks the current owner row to be safe under a concurrent transfer', () => {
    assert.match(migration, /FOR UPDATE/)
  })

  it('requires the new owner to already be an active member — never creates a membership', () => {
    assert.match(migration, /New owner must be an existing active member of the company/)
  })

  it('verifies exactly one owner remains after the transfer', () => {
    assert.match(migration, /v_owner_count <> 1/)
  })

  it('is not callable by ordinary authenticated clients', () => {
    assert.match(migration, /REVOKE ALL ON FUNCTION public\.transfer_company_ownership.* FROM PUBLIC/)
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.transfer_company_ownership.* TO service_role/)
  })
})

describe('Users page shows real company members and the Create User action', () => {
  const page = src('src/app/(dashboard)/users/page.tsx')

  it('primary action is Create User, not Invite User', () => {
    assert.match(page, /Create User<\/Button>/)
    assert.doesNotMatch(page, /Invite User/)
    assert.doesNotMatch(page, />Invite</)
  })

  it('loads users from the real company-membership endpoint', () => {
    assert.match(page, /fetch\('\/api\/users'\)/)
  })

  it('loads the current user to know whether they are Owner', () => {
    assert.match(page, /fetch\('\/api\/auth\/me'\)/)
    assert.match(page, /isSuperAdmin = me\?\.role === 'SUPER_ADMIN'/)
  })

  it('Transfer Ownership is only rendered for the Owner', () => {
    assert.match(page, /\{isSuperAdmin && \(/)
    assert.match(page, /Transfer Ownership/)
  })

  it('Create/Edit role options never include Owner or Super Admin', () => {
    assert.match(page, /const ROLES = \['ADMIN', 'ACCOUNTANT', 'VIEWER'\]/)
  })

  it('does not show a separate pending-invitation list mixed into the member table', () => {
    assert.doesNotMatch(page, /invitations/i)
  })

  it('editing the Owner never submits role: SUPER_ADMIN — that would be guaranteed-rejected by the server', () => {
    // Regression: u.role for the Owner's row is the display value 'SUPER_ADMIN' (publicRole('OWNER')).
    // openEdit seeds form.role from it, so a naive save would send role: 'SUPER_ADMIN' and the Owner
    // could never rename themselves. The body must omit role whenever the row being edited is the Owner.
    assert.match(
      page,
      /const body = editing\s*\n\s*\? \(editing\.role === 'SUPER_ADMIN' \? \{ name: form\.name \} : \{ name: form\.name, role: form\.role \}\)\s*\n\s*: form/,
    )
  })

  it('the role selector is hidden when editing the Owner, instead of showing a value not in its own option list', () => {
    assert.match(page, /editing\?\.role === 'SUPER_ADMIN' \? \(/)
  })
})
