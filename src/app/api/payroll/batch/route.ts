import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'
import { getNextSequence } from '@/lib/sequences'

export async function POST(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const { employeeIds, periodStart, periodEnd, period, taxRate, allowances, deductions } = body

    if (!employeeIds?.length) {
      return Response.json({ error: 'employeeIds array is required' }, { status: 400 })
    }

    const start = periodStart
      ? new Date(periodStart)
      : period
        ? new Date(`${period}-01T00:00:00.000Z`)
        : null
    const end = periodEnd
      ? new Date(periodEnd)
      : start
        ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
        : null

    if (!start || !end) {
      return Response.json({ error: 'period or periodStart/periodEnd is required' }, { status: 400 })
    }

    const effectiveTaxRate = Number(taxRate ?? 0)
    const defaultAllowances = Number(allowances ?? 0)
    const defaultDeductions = Number(deductions ?? 0)
    const periodLabel = period || start.toLocaleString('en', { month: 'long', year: 'numeric' })

    const results = []
    for (const employeeId of employeeIds as string[]) {
      const employee = await prisma.employee.findUnique({ where: { id: employeeId, companyId } })
      if (!employee) continue

      const basicSalary = employee.salary
      const grossSalary = basicSalary + defaultAllowances
      const taxAmount = grossSalary * (effectiveTaxRate / 100)
      const netSalary = grossSalary - defaultDeductions - taxAmount
      const payrollNo = await getNextSequence('PAYROLL', 'PRL-')

      const payroll = await prisma.payrollEntry.create({
        data: {
          payrollNo,
          employeeId,
          period: periodLabel,
          periodStart: start,
          periodEnd: end,
          basicSalary,
          allowances: defaultAllowances,
          deductions: defaultDeductions,
          taxAmount,
          netSalary,
          lines: {
            create: [
              { type: 'EARNING', description: 'Basic Salary', amount: basicSalary },
              ...(defaultAllowances > 0 ? [{ type: 'EARNING', description: 'Allowances', amount: defaultAllowances }] : []),
              ...(defaultDeductions > 0 ? [{ type: 'DEDUCTION', description: 'Deductions', amount: defaultDeductions }] : []),
              ...(taxAmount > 0 ? [{ type: 'DEDUCTION', description: 'Tax', amount: taxAmount }] : []),
            ],
          },
        },
        include: { employee: { select: { name: true } } },
      })
      results.push(payroll)
    }

    return Response.json({ created: results.length, payrolls: results }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
