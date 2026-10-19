import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { reverseJournalEntry } from '@/lib/accounting/journal-operations'
import { extractClientIp } from '@/lib/accounting/posting-audit'
import { PostingValidationError } from '@/lib/accounting/validation'

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const body = await req.json()
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''

    if (!reason) {
      return Response.json({ error: 'Reversal reason is required' }, { status: 400 })
    }

    const result = await reverseJournalEntry({
      journalId: id,
      userId: user.id,
      reason,
      reversalDate: body.reversalDate ? new Date(body.reversalDate) : undefined,
      ipAddress: extractClientIp(req),
    })

    return Response.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (error instanceof PostingValidationError) {
      return Response.json({ error: error.message, code: error.code }, { status: 400 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('journals.post', handlePost)
