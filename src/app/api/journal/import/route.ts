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

    // Group rows by date+description+reference so multi-line entries are handled
    const groups = new Map<string, Record<string, string>[]>()
    for (const row of rows) {
      const key = `${row.date}|${row.description}|${row.reference ?? ''}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }

    let created = 0
    const errors: string[] = []

    for (const [, groupRows] of groups) {
      const first = groupRows[0]
      const { date, description, reference } = first

      try {
        if (!date || !description) {
          errors.push(`Entry "${description ?? '?'}" on ${date ?? '?'}: Missing date or description`)
          continue
        }

        const lines = []
        let hasError = false

        for (const row of groupRows) {
          if (!row.accountNo) {
            errors.push(`Entry "${description}" on ${date}: A line is missing accountNo`)
            hasError = true
            break
          }
          const account = await prisma.chartOfAccount.findFirst({ where: { companyId, accountNo: row.accountNo } })
          if (!account) {
            errors.push(`Entry "${description}" on ${date}: Account "${row.accountNo}" not found`)
            hasError = true
            break
          }
          lines.push({
            accountId: account.id,
            description: row.lineDescription || description,
            debit: parseFloat(row.debit) || 0,
            credit: parseFloat(row.credit) || 0,
            taxRate: parseFloat(row.taxRate) || 0,
          })
        }

        if (hasError) continue

        if (lines.length < 2) {
          errors.push(`Entry "${description}" on ${date}: Need at least 2 lines`)
          continue
        }

        const totalDebit = lines.reduce((s, l) => s + l.debit, 0)
        const totalCredit = lines.reduce((s, l) => s + l.credit, 0)

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
          errors.push(`Entry "${description}" on ${date}: Debits ${totalDebit.toFixed(2)} ≠ Credits ${totalCredit.toFixed(2)}`)
          continue
        }

        const entryNo = await getNextSequence('JOURNAL', 'JV-')

        await prisma.journalEntry.create({
          data: {
            entryNo,
            date: new Date(date),
            description,
            reference: reference || null,
            totalDebit,
            totalCredit,
            createdById: user.id,
            lines: { create: lines },
          },
        })

        created++
      } catch (e) {
        errors.push(`Entry "${description}" on ${date}: ${String(e)}`)
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
