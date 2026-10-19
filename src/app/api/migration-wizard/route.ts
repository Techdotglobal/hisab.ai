import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin as requireAuth } from '@/lib/product-parity/permissions'
import { logAudit } from '@/lib/audit/log'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

const STEPS = ['COA_TEMPLATE', 'OPENING_BALANCES', 'IMPORT_DATA', 'REVIEW', 'COMPLETE'] as const

async function handleGet() {
  try {
    const user = await requireAuth()
    const companyId = await resolveCompanyId()
    const client = createAdminClient()

    const { data, error } = await client
      .from('migration_wizard_sessions')
      .select('*')
      .eq('company_id', companyId)
      .eq('status', 'IN_PROGRESS')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error

    if (data) return Response.json(data)

    const { data: created, error: createError } = await client
      .from('migration_wizard_sessions')
      .insert({
        company_id: companyId,
        user_id: user.id,
        step: 'COA_TEMPLATE',
        status: 'IN_PROGRESS',
        config: {},
      })
      .select('*')
      .single()

    if (createError) throw createError
    return Response.json(created)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const client = createAdminClient()

    const { data: session, error: sessionError } = await client
      .from('migration_wizard_sessions')
      .select('*')
      .eq('company_id', companyId)
      .eq('status', 'IN_PROGRESS')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (sessionError) throw sessionError
    if (!session) return Response.json({ error: 'No active session' }, { status: 404 })

    let nextStep = session.step as string
    if (body.action === 'advance') {
      const idx = STEPS.indexOf(session.step as typeof STEPS[number])
      nextStep = idx >= 0 && idx < STEPS.length - 1 ? STEPS[idx + 1] : session.step
    } else if (body.step) {
      nextStep = body.step
    }

    const config = { ...(session.config as Record<string, unknown>), ...(body.config ?? {}) }
    const status = nextStep === 'COMPLETE' ? 'COMPLETED' : session.status

    const { data: updated, error } = await client
      .from('migration_wizard_sessions')
      .update({
        step: nextStep,
        status,
        config,
        updated_at: new Date().toISOString(),
      })
      .eq('id', session.id)
      .eq('company_id', companyId)
      .select('*')
      .single()

    if (error) throw error

    await logAudit({
      action: body.action === 'advance' ? 'ADVANCE_STEP' : 'UPDATE',
      entityType: 'migration_wizard_session',
      entityId: session.id,
      userId: user.id,
      companyId,
      details: { step: nextStep },
    })

    return Response.json(updated)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('imports.view', handleGet)
export const POST = guarded('imports.run', handlePost)
