import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdjustingJournalEntry } from '@/lib/accounting/journal-operations'
import { extractClientIp } from '@/lib/accounting/posting-audit'
import { PostingValidationError } from '@/lib/accounting/validation'

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const body = await req.json()
    const { reason, date, lines, autoPost } = body

    if (!reason || !date || !Array.isArray(lines) || lines.length < 2) {
      return Response.json({ error: 'reason, date, and at least 2 lines are required' }, { status: 400 })
    }

    const result = await createAdjustingJournalEntry({
      journalId: id,
      userId: user.id,
      reason: String(reason),
      date: new Date(date),
      lines: lines.map((l: { accountId: string; debit?: number; credit?: number; description?: string; costCenterId?: string }) => ({
        accountId: l.accountId,
        debit: Number(l.debit ?? 0),
        credit: Number(l.credit ?? 0),
        description: l.description,
        costCenterId: l.costCenterId ?? null,
      })),
      autoPost: autoPost !== false,
      ipAddress: extractClientIp(req),
    })

    return Response.json(result, { status: 201 })
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
