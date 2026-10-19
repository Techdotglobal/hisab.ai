import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { getDocumentWithDetails, addDocumentComment, archiveDocument } from '@/lib/platform/documents/service'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    const companyId = await resolveCompanyId()

    if (id) {
      const doc = await getDocumentWithDetails(id, companyId)
      return Response.json(doc)
    }

    const client = createAdminClient()
    let query = client
      .from('documents')
      .select('*, category:document_categories(name)')
      .eq('company_id', companyId)
      .neq('status', 'DELETED')
      .order('created_at', { ascending: false })
      .limit(100)

    const status = searchParams.get('status')
    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error
    return Response.json({ documents: data ?? [] })
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
    const body = await request.json()

    if (body.action === 'comment' && body.documentId) {
      const comment = await addDocumentComment(body.documentId, body.body, user.id)
      return Response.json(comment, { status: 201 })
    }

    if (body.action === 'archive' && body.documentId) {
      await archiveDocument(body.documentId)
      return Response.json({ success: true })
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('platform.manage', handleGet)
export const POST = guarded('platform.manage', handlePost)
