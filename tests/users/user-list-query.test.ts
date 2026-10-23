import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

// company_users and profiles both reference auth.users with no foreign key between them, so PostgREST
// rejects `profiles(...)` embedded in a company_users select (PGRST200) and the whole list 500s.
test('company_users selects never embed profiles; profiles load through a second query', () => {
  const service = read('src/lib/permissions/service.ts')
  const authUsers = read('src/lib/supabase/auth-users.ts')

  for (const source of [service, authUsers]) {
    assert.doesNotMatch(source, /from\('company_users'\)[\s\S]{0,200}\.select\('[^']*profiles\(/)
  }
  assert.match(service, /loadProfilesById\(admin,/)
  assert.match(authUsers, /export async function loadProfilesById/)
  assert.match(authUsers, /from\('profiles'\)\.select\('id, full_name, avatar_url, is_active'\)\.in\('id', userIds\)/)
})

test('the Users page distinguishes a failed load from an empty directory', () => {
  const page = read('src/app/(dashboard)/users/page.tsx')
  assert.match(page, /setLoadFailed\(!usersRes\.ok && usersRes\.status !== 403\)/)
  assert.match(page, /loadFailed \? 'Users could not be loaded\.' : 'No users found\.'/)
})
