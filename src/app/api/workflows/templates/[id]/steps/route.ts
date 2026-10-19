import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id: templateId } = await params
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const client = createAdminClient()

    const { data: step, error } = await client
      .from('workflow_template_steps')
      .insert({
        company_id: companyId,
        template_id: templateId,
        step_order: Number(body.stepOrder ?? 1),
        name: String(body.name ?? 'Approval Step'),
        approval_mode: body.approvalMode ?? 'SEQUENTIAL',
        parallel_policy: body.parallelPolicy ?? 'ALL',
        amount_min: body.amountMin ?? null,
        amount_max: body.amountMax ?? null,
        conditions: body.conditions ?? {},
        escalation_hours: body.escalationHours ?? null,
        escalation_user_id: body.escalationUserId ?? null,
        reminder_hours: body.reminderHours ?? null,
      })
      .select('*')
      .single()

    if (error) throw error

    const approvers = Array.isArray(body.approvers) ? body.approvers : []
    if (approvers.length > 0) {
      const rows = approvers.map((a: Record<string, unknown>, index: number) => ({
        company_id: companyId,
        step_id: step.id,
        sequence: Number(a.sequence ?? index + 1),
        approver_type: a.approverType ?? 'USER',
        user_id: a.userId ?? null,
        role: a.role ?? null,
        department_id: a.departmentId ?? null,
      }))
      await client.from('workflow_template_step_approvers').insert(rows)
    }

    return Response.json(step, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('workflows.manage', handlePost)
