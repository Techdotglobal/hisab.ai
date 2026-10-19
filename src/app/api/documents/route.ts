import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, listCompanyRows } from '@/lib/api/crud'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { mkdir, writeFile } from 'fs/promises'
import { join, basename } from 'path'
import { buildSafeStorageFileName, validateDocumentUpload } from '@/lib/security/document-upload'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const entityType = searchParams.get('entityType')
    const entityId = searchParams.get('entityId')
    const filters: Record<string, unknown> = {}
    if (entityType) filters.entity_type = entityType
    if (entityId) filters.entity_id = entityId

    const rows = await listCompanyRows('documents', {
      orderBy: 'created_at',
      filters: Object.keys(filters).length ? filters : undefined,
    })
    return Response.json(rows)
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
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const entityType = formData.get('entityType') as string | null
    const entityId = formData.get('entityId') as string | null

    if (!file || !entityType || !entityId) {
      return Response.json({ error: 'file, entityType, entityId are required' }, { status: 400 })
    }

    const validationError = validateDocumentUpload(file)
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 })
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    const fileName = buildSafeStorageFileName(file.name)
    const dir = join(process.cwd(), 'public', 'documents')
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, basename(fileName))
    await writeFile(filePath, buffer)

    const client = createAdminClient()
    const { data, error } = await client
      .from('documents')
      .insert({
        company_id: companyId,
        entity_type: entityType,
        entity_id: entityId,
        file_name: file.name,
        file_path: `/documents/${fileName}`,
        mime_type: file.type || 'application/octet-stream',
        uploaded_by_id: user.id,
      })
      .select('*')
      .single()

    if (error) throw error
    return Response.json(data, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
    await deleteCompanyRow('documents', id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
export const POST = guarded(['invoices.edit', 'bills.edit', 'expenses.edit', 'platform.manage'], handlePost)
export const DELETE = guarded(['invoices.edit', 'bills.edit', 'expenses.edit', 'platform.manage'], handleDelete)
