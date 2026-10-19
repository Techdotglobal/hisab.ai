import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getInvoiceRepository } from '@/lib/db/provider'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { mapInvoiceAttachmentRow } from '@/lib/db/entity-mappers'
import { canEditInvoice } from '@/lib/ui/invoice-status'
import { readFile } from 'fs/promises'
import { join } from 'path'

function canMutateAttachments(status: string, zatcaStatus?: string | null): boolean {
  return status === 'DRAFT' && canEditInvoice(zatcaStatus)
}

async function handleGet(
  _req: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id: invoiceId, attachmentId } = await params
    const invoice = await getInvoiceRepository().findById(invoiceId)
    if (!invoice) return Response.json({ error: 'Invoice not found' }, { status: 404 })

    const client = createAdminClient()
    const { data, error } = await client
      .from('invoice_attachments')
      .select('*')
      .eq('company_id', companyId)
      .eq('invoice_id', invoice.id)
      .eq('id', attachmentId)
      .is('deleted_at', null)
      .maybeSingle()

    if (error) throw error
    if (!data) return Response.json({ error: 'Attachment not found' }, { status: 404 })

    const attachment = mapInvoiceAttachmentRow(data)
    const diskPath = join(process.cwd(), 'public', attachment.storagePath.replace(/^\//, ''))
    const buffer = await readFile(diskPath)

    return new Response(buffer, {
      headers: {
        'Content-Type': attachment.mimeType,
        'Content-Disposition': `attachment; filename="${attachment.originalFilename.replace(/"/g, '')}"`,
        'Content-Length': String(buffer.length),
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(
  _req: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id: invoiceId, attachmentId } = await params
    const invoice = await getInvoiceRepository().findById(invoiceId)
    if (!invoice) return Response.json({ error: 'Invoice not found' }, { status: 404 })

    if (!canMutateAttachments(invoice.status, invoice.zatcaStatus)) {
      return Response.json(
        { error: 'Attachments can only be deleted before invoice submission' },
        { status: 400 },
      )
    }

    const client = createAdminClient()
    const { data, error } = await client
      .from('invoice_attachments')
      .update({ deleted_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('invoice_id', invoice.id)
      .eq('id', attachmentId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()

    if (error) throw error
    if (!data) return Response.json({ error: 'Attachment not found' }, { status: 404 })
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('invoices.view', handleGet)
export const DELETE = guarded('invoices.edit', handleDelete)
