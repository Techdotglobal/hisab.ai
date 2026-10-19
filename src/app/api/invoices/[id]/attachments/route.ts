import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getInvoiceRepository } from '@/lib/db/provider'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { mapInvoiceAttachmentRow } from '@/lib/db/entity-mappers'
import { buildSafeStorageFileName, validateDocumentUpload } from '@/lib/security/document-upload'
import { mkdir, writeFile } from 'fs/promises'
import { join, basename } from 'path'
import { canEditInvoice } from '@/lib/ui/invoice-status'

function canMutateAttachments(status: string, zatcaStatus?: string | null): boolean {
  return status === 'DRAFT' && canEditInvoice(zatcaStatus)
}

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id: invoiceId } = await params
    const invoice = await getInvoiceRepository().findById(invoiceId)
    if (!invoice) return Response.json({ error: 'Invoice not found' }, { status: 404 })

    const client = createAdminClient()
    const { data, error } = await client
      .from('invoice_attachments')
      .select('*')
      .eq('company_id', companyId)
      .eq('invoice_id', invoice.id)
      .is('deleted_at', null)
      .order('uploaded_at', { ascending: false })

    if (error) throw error
    return Response.json((data ?? []).map(mapInvoiceAttachmentRow))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth()
    const companyId = await resolveCompanyId()
    const { id: invoiceIdParam } = await params
    const invoice = await getInvoiceRepository().findById(invoiceIdParam)
    if (!invoice) return Response.json({ error: 'Invoice not found' }, { status: 404 })

    if (!canMutateAttachments(invoice.status, invoice.zatcaStatus)) {
      return Response.json(
        { error: 'Attachments can only be added before invoice submission' },
        { status: 400 },
      )
    }

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    if (!file) return Response.json({ error: 'file is required' }, { status: 400 })

    const validationError = validateDocumentUpload(file)
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 })
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    const safeName = buildSafeStorageFileName(file.name)
    const dir = join(process.cwd(), 'public', 'invoice-attachments', companyId)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, basename(safeName))
    await writeFile(filePath, buffer)

    const storagePath = `/invoice-attachments/${companyId}/${safeName}`
    const client = createAdminClient()
    const { data, error } = await client
      .from('invoice_attachments')
      .insert({
        company_id: companyId,
        invoice_id: invoice.id,
        filename: safeName,
        original_filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        file_size: file.size,
        storage_path: storagePath,
        uploaded_by_id: user.id,
      })
      .select('*')
      .single()

    if (error) throw error
    return Response.json(mapInvoiceAttachmentRow(data), { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
export const POST = guarded('invoices.edit', handlePost)
