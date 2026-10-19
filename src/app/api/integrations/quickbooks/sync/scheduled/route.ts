import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin as requireAuth } from '@/lib/product-parity/permissions'
import { getQuickBooksSyncSettings, saveQuickBooksSyncSettings, syncQuickBooks } from '@/lib/accounting/quickbooks-sync'
import { apiError } from '@/lib/import-export/api-helpers'

function nextRun(cron: string | null): string {
  const text = (cron ?? '').toLowerCase()
  const interval = text === '@daily' || text.includes(' 0 ') ? 24 * 60 * 60 * 1000 : text === '@weekly' ? 7 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000
  return new Date(Date.now() + interval).toISOString()
}

async function handlePost() {
  try {
    const user = await requireAuth(); const settings = await getQuickBooksSyncSettings(user.companyId)
    if (!settings.scheduleEnabled) return Response.json({ skipped: true, reason: 'Scheduling is disabled.' })
    if (settings.nextRunAt && new Date(settings.nextRunAt).getTime() > Date.now()) return Response.json({ skipped: true, nextRunAt: settings.nextRunAt })
    const result = await syncQuickBooks(user.companyId, user.id)
    await saveQuickBooksSyncSettings(user.companyId, { nextRunAt: nextRun(settings.scheduleCron) })
    return Response.json(result)
  } catch (error) { return apiError(error) }
}

export const POST = guarded('integrations.manage', handlePost)
