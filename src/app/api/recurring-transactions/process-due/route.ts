import { guarded } from '@/lib/permissions/guard'
import { createAdminClient } from '@/lib/supabase/admin'
import { processDueRecurringTransactions } from '@/lib/recurring-transactions/service'

async function handlePost(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = await request.json().catch(() => ({})) as { companyId?: string; systemUserId?: string; limit?: number }
  if (!body.companyId || !body.systemUserId) return Response.json({ error: 'companyId and systemUserId are required' }, { status: 400 })
  const { data: member, error } = await createAdminClient().from('company_users').select('id').eq('company_id', body.companyId)
    .eq('user_id', body.systemUserId).eq('is_active', true).maybeSingle()
  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!member) return Response.json({ error: 'System user is not a member of the company' }, { status: 400 })
  const results = await processDueRecurringTransactions(body.companyId, body.systemUserId, body.limit)
  return Response.json({ processed: results.length, results })
}

export const POST = guarded(['invoices.edit', 'bills.edit', 'expenses.edit'], handlePost)
