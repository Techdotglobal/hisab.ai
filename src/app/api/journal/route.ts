import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
import { prisma } from '@/lib/prisma'
import { getNextSequence } from '@/lib/sequences'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { maybeStartWorkflow } from '@/lib/workflow/integration'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

/**
 * List journals the same way Recent Activity does: tenant-scoped + soft-delete aware.
 * The Prisma shim's findMany does not implement AND/OR and does not inject company_id,
 * so the previous listing query failed and the page silently showed an empty list.
 *
 * Paginated at the database level (`.range()` on the root `journal_entries` query, which
 * bounds how many entries PostgREST fetches before joining their nested lines/account/
 * cost-center rows — the nested join itself is never re-run per entry, so this stays a
 * single bounded query rather than an N+1). Before this, the route fetched every entry for
 * the company in one unbounded query; with ~2,100 entries and some carrying 20-57 lines
 * each, that query started hitting Postgres' statement timeout (57014) outright.
 */
export async function GET(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const search = (searchParams.get('search') ?? '').trim()
    const status = (searchParams.get('status') ?? '').trim()
    const page = Math.max(1, Math.floor(Number(searchParams.get('page')) || 1))
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(searchParams.get('pageSize')) || DEFAULT_PAGE_SIZE)))
    const client = createAdminClient()
    const safeSearch = search
      // Strip PostgREST or()-filter metacharacters so user input cannot break the filter.
      ? search.replace(/[%_,.()]/g, ' ').replace(/\s+/g, ' ').trim()
      : ''

    let query = client
      .from('journal_entries')
      .select(`
        *,
        created_by:profiles!created_by_id(full_name),
        lines:journal_lines(
          *,
          account:chart_of_accounts(*),
          cost_center:cost_centers(*)
        )
      `, { count: 'exact' })
      .eq('company_id', companyId)
      .is('deleted_at', null)
      // `date` alone is not a unique key — many entries share a date, which would let
      // .range() skip or repeat rows across pages depending on how Postgres breaks ties.
      // `id` as a secondary sort makes the ordering (and therefore the pagination) stable.
      .order('date', { ascending: false })
      .order('id', { ascending: false })

    if (status) query = query.eq('status', status)
    if (safeSearch) query = query.or(`entry_no.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%`)

    const from = (page - 1) * pageSize
    const { data, error, count } = await query.range(from, from + pageSize - 1)

    let entries: Array<Record<string, unknown>> = []
    let total = count ?? 0
    if (error) {
      // A page past the last one asks PostgREST for an offset beyond the row count, which it
      // reports as PGRST103 ("Requested range not satisfiable") with data/count both null,
      // rather than an empty result — that is a valid, expected page value, not a real error.
      // Re-run just the count (no range) so the response still reports the real total/totalPages.
      if (error.code !== 'PGRST103') throw error
      let countQuery = client.from('journal_entries').select('id', { count: 'exact', head: true }).eq('company_id', companyId).is('deleted_at', null)
      if (status) countQuery = countQuery.eq('status', status)
      if (safeSearch) countQuery = countQuery.or(`entry_no.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%`)
      const countOnly = await countQuery
      if (countOnly.error) throw countOnly.error
      total = countOnly.count ?? 0
    } else {
      entries = (toCamel(data ?? []) as Array<Record<string, unknown>>).map((row) => {
        const createdBy = row.createdBy as { fullName?: string; name?: string } | null | undefined
        return {
          ...row,
          createdBy: { name: createdBy?.name ?? createdBy?.fullName ?? '' },
        }
      })
    }
    return Response.json({
      items: entries,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()
    const { date, description, reference, lines } = body

    if (!lines || lines.length < 2) {
      return Response.json({ error: 'At least 2 lines required' }, { status: 400 })
    }

    const totalDebit = lines.reduce((s: number, l: { debit: number }) => s + (l.debit || 0), 0)
    const totalCredit = lines.reduce((s: number, l: { credit: number }) => s + (l.credit || 0), 0)

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return Response.json({ error: 'Debits must equal credits' }, { status: 400 })
    }

    const entryNo = await getNextSequence('JOURNAL', 'JV-')

    const entry = await prisma.journalEntry.create({
      data: {
        entryNo,
        date: new Date(date),
        description,
        reference,
        totalDebit,
        totalCredit,
        createdById: user.id,
        lines: {
          create: lines.map((l: {
            accountId: string; costCenterId?: string; description?: string;
            debit?: number; credit?: number; taxRate?: number
          }) => ({
            accountId: l.accountId,
            costCenterId: l.costCenterId || null,
            description: l.description,
            debit: l.debit || 0,
            credit: l.credit || 0,
            taxRate: l.taxRate || 0,
          })),
        },
      },
      include: { lines: { include: { account: true } } },
    })

    const companyId = await resolveCompanyId()
    await maybeStartWorkflow({
      entityType: 'JOURNAL_ENTRY',
      entityId: entry.id,
      entityLabel: entry.entryNo,
      amount: totalDebit,
      submittedById: user.id,
      companyId,
    })

    return Response.json(entry, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
