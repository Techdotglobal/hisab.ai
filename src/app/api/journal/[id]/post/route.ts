import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { postJournalEntry } from '@/lib/accounting/posting-service'
import { extractClientIp } from '@/lib/accounting/posting-audit'
import { PostingValidationError } from '@/lib/accounting/validation'
import { resolveCompanyId } from '@/lib/tenant'
import { requireApprovedWorkflow, WorkflowError } from '@/lib/workflow/integration'

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const companyId = await resolveCompanyId()
    const body = await req.json().catch(() => ({}))
    const reason = typeof body.reason === 'string' ? body.reason : undefined

    await requireApprovedWorkflow('JOURNAL_ENTRY', id, companyId)

    const postingSequence = await postJournalEntry(id, {
      userId: user.id,
      reason,
      ipAddress: extractClientIp(req),
    })

    return Response.json({ success: true, status: 'POSTED', postingSequence })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof PostingValidationError) {
      return Response.json({ error: error.message, code: error.code }, { status: 400 })
    }
    if (error instanceof WorkflowError) {
      return Response.json({ error: error.message, code: error.code }, { status: 400 })
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('not found')) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }
    if (message.includes('Already posted') || message.includes('Duplicate posting')) {
      return Response.json({ error: message }, { status: 400 })
    }
    if (message.includes('closed')) {
      return Response.json({ error: message }, { status: 409 })
    }
    return Response.json({ error: message }, { status: 500 })
  }
}

export const POST = guarded('journals.post', handlePost)
