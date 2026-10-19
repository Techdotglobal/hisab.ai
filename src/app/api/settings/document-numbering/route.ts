import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import {
  buildPreview,
  getInvoiceNumberingContext,
  listDocumentSequences,
  resetDocumentSequenceToDefault,
  updateDocumentSequence,
} from '@/lib/document-numbering/service'
import { DOCUMENT_TYPE_DEFAULTS } from '@/lib/document-numbering/types'

async function handleGet() {
  try {
    await requireAuth()
    const sequences = await listDocumentSequences()
    const invoice =
      sequences.find((s) => s.documentType === 'INVOICE') ??
      sequences[0]

    const context = invoice
      ? await getInvoiceNumberingContext(invoice.prefix)
      : {
          hasInvoices: false,
          lastIssuedInvoiceNo: null,
          lastIssuedSequence: null,
          minNextNumber: 1,
        }

    return Response.json({
      sequences: sequences.map((s) => ({
        ...s,
        preview: buildPreview({
          prefix: s.prefix,
          nextNumber: s.nextNumber,
          padding: s.padding,
          suffix: s.suffix,
        }),
        label:
          DOCUMENT_TYPE_DEFAULTS[s.documentType as keyof typeof DOCUMENT_TYPE_DEFAULTS]
            ?.label ?? s.documentType,
      })),
      invoice: invoice
        ? {
            ...invoice,
            preview: buildPreview({
              prefix: invoice.prefix,
              nextNumber: invoice.nextNumber,
              padding: invoice.padding,
              suffix: invoice.suffix,
            }),
            minNextNumber: context.minNextNumber,
            hasInvoices: context.hasInvoices,
            lastIssuedInvoiceNo: context.lastIssuedInvoiceNo,
            lastIssuedSequence: context.lastIssuedSequence,
          }
        : null,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    const documentType = String(body.documentType ?? 'INVOICE').toUpperCase()
    const action = String(body.action ?? 'save')

    if (action === 'reset') {
      const sequence = await resetDocumentSequenceToDefault(documentType)
      return Response.json({
        sequence: {
          ...sequence,
          preview: buildPreview({
            prefix: sequence.prefix,
            nextNumber: sequence.nextNumber,
            padding: sequence.padding,
            suffix: sequence.suffix,
          }),
        },
      })
    }

    const sequence = await updateDocumentSequence(documentType, {
      prefix: body.prefix,
      startingNumber: body.startingNumber != null ? Number(body.startingNumber) : undefined,
      nextNumber: body.nextNumber != null ? Number(body.nextNumber) : undefined,
      padding: body.padding != null ? Number(body.padding) : undefined,
      suffix: body.suffix,
    })

    return Response.json({
      sequence: {
        ...sequence,
        preview: buildPreview({
          prefix: sequence.prefix,
          nextNumber: sequence.nextNumber,
          padding: sequence.padding,
          suffix: sequence.suffix,
        }),
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const message = error instanceof Error ? error.message : String(error)
    const status = /prefix|padding|next number|starting number|suffix/i.test(message) ? 400 : 500
    return Response.json({ error: message }, { status })
  }
}

export const GET = guarded('settings.view', handleGet)
export const PUT = guarded('settings.manage', handlePut)
