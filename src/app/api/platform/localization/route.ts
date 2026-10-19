import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getLocaleSettings } from '@/lib/platform/localization/format'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const locale = searchParams.get('locale')

    const settings = await getLocaleSettings(companyId)
    const client = createAdminClient()

    let translationsQuery = client
      .from('translations')
      .select('namespace, locale, message_key, message_value')
      .order('message_key')
      .limit(200)

    if (locale) translationsQuery = translationsQuery.eq('locale', locale)

    const { data: translations, error } = await translationsQuery
    if (error) throw error

    return Response.json({ settings, translations: translations ?? [] })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const client = createAdminClient()

    if (body.action === 'translation') {
      const { upsertTranslation } = await import('@/lib/platform/localization/format')
      const row = await upsertTranslation({
        namespace: body.namespace,
        locale: body.locale,
        key: body.key,
        value: body.value,
      })
      return Response.json(row, { status: 201 })
    }

    const { data, error } = await client
      .from('locale_settings')
      .upsert({
        company_id: companyId,
        locale: body.locale ?? 'en-SA',
        timezone: body.timezone ?? 'Asia/Riyadh',
        date_format: body.dateFormat ?? 'YYYY-MM-DD',
        number_format: body.numberFormat ?? '1,234.56',
        currency_display: body.currencyDisplay ?? 'symbol',
      }, { onConflict: 'company_id' })
      .select('*')
      .single()

    if (error) throw error
    return Response.json(data)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
export const POST = guarded('platform.manage', handlePost)
