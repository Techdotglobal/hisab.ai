import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { COMPANY_COOKIE } from '@/lib/tenant'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'

async function handleGet() {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const admin = createAdminClient()
    const { data: memberships, error: membershipError } = await admin
      .from('company_users')
      .select('company_id, role, companies(id, company_name, currency, country)')
      .eq('user_id', data.user.id)
      .eq('is_active', true)

    if (membershipError) throw membershipError

    const cookieStore = await cookies()
    const activeCompanyId = cookieStore.get(COMPANY_COOKIE)?.value

    const companies = (memberships ?? []).map((m) => {
      const company = m.companies as unknown as {
        id: string
        company_name: string
        currency: string
        country: string
      } | null
      return {
        id: String(m.company_id),
        name: company?.company_name ?? 'Company',
        currency: company?.currency ?? 'SAR',
        country: company?.country ?? 'Saudi Arabia',
        role: m.role,
        isActive: String(m.company_id) === activeCompanyId,
      }
    })

    return Response.json(companies)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    if (error || !data.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    if (!body.companyId) {
      return Response.json({ error: 'companyId is required' }, { status: 400 })
    }

    const admin = createAdminClient()
    const { data: membership, error: membershipError } = await admin
      .from('company_users')
      .select('id')
      .eq('user_id', data.user.id)
      .eq('company_id', body.companyId)
      .eq('is_active', true)
      .maybeSingle()

    if (membershipError) throw membershipError
    if (!membership) {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }

    const cookieStore = await cookies()
    cookieStore.set(COMPANY_COOKIE, body.companyId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    })

    return Response.json({ success: true, companyId: body.companyId })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
export const POST = guarded('settings.manage', handlePost)
