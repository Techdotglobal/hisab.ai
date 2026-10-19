import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getNextSequence } from '@/lib/sequences'

const VALID_CATEGORIES = ['Travel', 'Meals', 'Office Supplies', 'Utilities', 'Software', 'Equipment', 'Marketing', 'Other']

async function handlePost(request: Request) {
  try {
    const user = await requireAuth()
    const { rows } = await request.json()

    if (!Array.isArray(rows) || rows.length === 0) {
      return Response.json({ error: 'No rows provided' }, { status: 400 })
    }

    let created = 0
    const errors: string[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      try {
        const { date, description, category, amount, taxRate, lineDescription } = row

        if (!date || !description || !category || !amount) {
          errors.push(`Row ${i + 1}: Missing required fields (date, description, category, amount)`)
          continue
        }

        const amt = parseFloat(amount) || 0
        const tax = parseFloat(taxRate) || 0
        const cat = VALID_CATEGORIES.includes(category) ? category : 'Other'

        const expenseNo = await getNextSequence('EXPENSE', 'EXP-')

        await prisma.expense.create({
          data: {
            expenseNo,
            date: new Date(date),
            description,
            category: cat,
            total: amt,
            taxAmount: amt * (tax / 100),
            createdById: user.id,
            lines: {
              create: [{
                description: lineDescription || description,
                amount: amt,
                taxRate: tax,
              }],
            },
          },
        })

        created++
      } catch (e) {
        errors.push(`Row ${i + 1}: ${String(e)}`)
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

export const POST = guarded('expenses.edit', handlePost)
