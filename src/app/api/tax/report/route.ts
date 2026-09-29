import { requireAuth } from '@/lib/auth'
import { findSystemAccount } from '@/lib/accounting/posting-service'
import { queryLedgerEntries } from '@/lib/accounting/ledger'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'

type TaxRow = { taxAmount: number; subtotal: number }

export async function GET(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const from = searchParams.get('from') ? new Date(searchParams.get('from')!) : new Date(new Date().getFullYear(), 0, 1)
    const to = searchParams.get('to') ? new Date(searchParams.get('to')!) : new Date()

    const [vatPayableId, vatReceivableId] = await Promise.all([
      findSystemAccount(companyId, { nameContains: 'VAT Payable' }),
      findSystemAccount(companyId, { nameContains: 'VAT Receivable' }),
    ])

    let vatCollected = 0
    let vatPaid = 0
    let ledgerUsed = false

    if (vatPayableId || vatReceivableId) {
      const ledgerRows = await queryLedgerEntries({ companyId, from, to })
      const payableCredit = ledgerRows
        .filter((r) => r.accountId === vatPayableId)
        .reduce((s, r) => s + r.credit - r.debit, 0)
      const receivableDebit = ledgerRows
        .filter((r) => r.accountId === vatReceivableId)
        .reduce((s, r) => s + r.debit - r.credit, 0)

      if (payableCredit > 0 || receivableDebit > 0) {
        vatCollected = payableCredit
        vatPaid = receivableDebit
        ledgerUsed = true
      }
    }

    const invoices = await prisma.invoice.findMany({
      where: {
        companyId,
        date: { gte: from, lte: to },
        status: { in: ['SENT', 'PAID', 'PARTIAL'] },
      },
      select: { taxAmount: true, subtotal: true },
    })

    const invoiceRows = invoices as TaxRow[]
    const salesAmount = invoiceRows.reduce((s: number, i: TaxRow) => s + i.subtotal, 0)
    if (!ledgerUsed) {
      vatCollected = invoiceRows.reduce((s: number, i: TaxRow) => s + i.taxAmount, 0)
    }

    const bills = await prisma.bill.findMany({
      where: {
        companyId,
        date: { gte: from, lte: to },
        status: { in: ['RECEIVED', 'PAID', 'PARTIAL'] },
      },
      select: { taxAmount: true, subtotal: true },
    })

    const billRows = bills as TaxRow[]
    const purchasesAmount = billRows.reduce((s: number, b: TaxRow) => s + b.subtotal, 0)
    if (!ledgerUsed) {
      vatPaid = billRows.reduce((s: number, b: TaxRow) => s + b.taxAmount, 0)
    }

    const vatPayable = vatCollected - vatPaid

    return Response.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      sales: { amount: salesAmount, vatCollected, invoiceCount: invoices.length },
      purchases: { amount: purchasesAmount, vatPaid, billCount: bills.length },
      vatPayable,
      summary: vatPayable > 0 ? 'VAT PAYABLE TO ZATCA' : 'VAT REFUNDABLE FROM ZATCA',
      source: ledgerUsed ? 'ledger_entries' : 'documents',
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
