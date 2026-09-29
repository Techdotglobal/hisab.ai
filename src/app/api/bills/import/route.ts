import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'

export async function POST(request: Request) {
  try {
    const user = await requireAuth()
    const companyId = await resolveCompanyId()
    const { rows } = await request.json()

    if (!Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: 'No rows provided' }, { status: 400 })
    }

    // Group rows by vendorName+date+dueDate+reference so multi-line bills are handled
    const groups = new Map<string, Record<string, string>[]>()
    for (const row of rows) {
      const key = `${row.vendorName}|${row.date}|${row.dueDate}|${row.reference ?? ''}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }

    let created = 0
    const errors: string[] = []

    for (const [, groupRows] of groups) {
      const first = groupRows[0]
      const { vendorName, date, dueDate, reference } = first

      try {
        if (!vendorName || !date || !dueDate) {
          errors.push(`Bill "${vendorName ?? '?'}" on ${date ?? '?'}: Missing vendorName, date, or dueDate`)
          continue
        }

        const vendor = await prisma.vendor.findFirst({ where: { companyId, name: { equals: vendorName } } })
        if (!vendor) {
          errors.push(`Bill "${vendorName}" on ${date}: Vendor not found — create it first`)
          continue
        }

        let subtotal = 0
        let taxAmount = 0
        const lines = groupRows.map(row => {
          const qty = parseFloat(row.quantity) || 1
          const price = parseFloat(row.unitPrice) || 0
          const tax = parseFloat(row.taxRate) || 0
          const lineAmount = qty * price
          const lineTax = lineAmount * (tax / 100)
          subtotal += lineAmount
          taxAmount += lineTax
          return {
            description: row.lineDescription || row.description || '',
            quantity: qty,
            unitPrice: price,
            taxRate: tax,
            amount: lineAmount,
          }
        })

        const total = subtotal + taxAmount
        const billNo = await getNextSequence('BILL', 'BILL-')

        await prisma.bill.create({
          data: {
            billNo,
            vendorId: vendor.id,
            date: new Date(date),
            dueDate: new Date(dueDate),
            subtotal,
            taxAmount,
            total,
            balance: total,
            reference: reference || null,
            status: 'RECEIVED',
            createdById: user.id,
            lines: { create: lines },
          },
        })

        created++
      } catch (e) {
        errors.push(`Bill "${vendorName}" on ${date}: ${String(e)}`)
      }
    }

    return Response.json({ created, errors })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
