import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { cloneJournalEntry } from '@/lib/accounting/journal-operations'

async function handlePost(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const { id } = await params
    const result = await cloneJournalEntry({ journalId: id, userId: user.id })
    return Response.json(result, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('journals.edit', handlePost)
