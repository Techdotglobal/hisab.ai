import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(path, 'utf8')

test('journal list API scopes like Recent Activity (company + soft-delete)', () => {
  const route = read('src/app/api/journal/route.ts')
  const dashboard = read('src/lib/db/repositories/dashboard.repository.supabase.ts')

  assert.match(dashboard, /from\('journal_entries'\)/)
  assert.match(dashboard, /\.eq\('company_id', companyId\)/)
  assert.match(dashboard, /\.is\('deleted_at', null\)/)

  assert.match(route, /from\('journal_entries'\)/)
  assert.match(route, /\.eq\('company_id', companyId\)/)
  assert.match(route, /\.is\('deleted_at', null\)/)
  assert.match(route, /resolveCompanyId\(\)/)
  assert.match(route, /createAdminClient\(\)/)
  assert.match(route, /journal_lines/)
  assert.match(route, /chart_of_accounts/)

  // Must not use the broken Prisma AND/OR listing shape that PostgREST rejects.
  assert.doesNotMatch(route, /prisma\.journalEntry\.findMany/)
  assert.doesNotMatch(route, /AND:\s*\[/)
})

test('journal list is paginated at the database level, not fetched whole and sliced', () => {
  const route = read('src/app/api/journal/route.ts')

  // Bounded query: the outer journal_entries select must carry a .range(), not an
  // unbounded select that a 2,100+-row, deeply-nested-lines company hits the Postgres
  // statement timeout on (see the 57014 production incident this fixes).
  assert.match(route, /\.range\(from, from \+ pageSize - 1\)/)
  assert.match(route, /count:\s*'exact'/)

  // A default and an enforced maximum page size, both present as named constants.
  assert.match(route, /DEFAULT_PAGE_SIZE\s*=\s*\d+/)
  assert.match(route, /MAX_PAGE_SIZE\s*=\s*\d+/)
  assert.match(route, /Math\.min\(MAX_PAGE_SIZE/)

  // Deterministic ordering: date alone is not unique, so a secondary order key is
  // required or .range() can skip/repeat rows across pages when dates tie.
  assert.match(route, /\.order\('date',\s*\{\s*ascending:\s*false\s*\}\)/)
  assert.match(route, /\.order\('id',\s*\{\s*ascending:\s*false\s*\}\)/)

  // A page past the last one must not surface as a 500 — PostgREST reports that
  // specific range as PGRST103, which the route has to treat as "zero rows", not an error.
  assert.match(route, /PGRST103/)

  // Response carries pagination metadata the frontend needs to render Prev/Next and a count.
  assert.match(route, /items:\s*entries/)
  assert.match(route, /totalPages:/)

  // The whole point: no fetch-everything-then-slice-in-memory shape.
  assert.doesNotMatch(route, /\.slice\(/)
})

test('journal page consumes the paginated response shape and drives Prev/Next from it', () => {
  const page = read('src/app/(dashboard)/journal/page.tsx')

  assert.match(page, /fetch\(`\/api\/journal\?\$\{params\}`\)/)
  assert.match(page, /if \(entRes\.ok\)/)
  assert.match(page, /setEntries\(payload\.items\)/)
  assert.match(page, /setTotalPages\(payload\.totalPages\)/)
  assert.match(page, /readApiError\(entRes\)/)

  // page state must actually reach the request, or Prev/Next would be inert.
  assert.match(page, /page:\s*String\(page\)/)
  assert.match(page, /const \[page, setPage\] = useState\(1\)/)
})
