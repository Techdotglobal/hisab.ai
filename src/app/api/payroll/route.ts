import { requireAuth } from '@/lib/auth'
import { guarded } from '@/lib/permissions/guard'
import { getPayrollRepository } from '@/lib/db/provider'
import { prisma } from '@/lib/prisma'
import { getNextSequence } from '@/lib/sequences'
import { resolveCompanyId } from '@/lib/tenant'
import { maybeStartWorkflow } from '@/lib/workflow/integration'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? undefined
    const payrolls = await getPayrollRepository().findMany({ search })
    return Response.json(payrolls)
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
    const { employeeId, periodStart, periodEnd, period, allowances, deductions, taxRate, notes } = body

    if (!employeeId) {
      return Response.json({ error: 'employeeId is required' }, { status: 400 })
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

    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return Response.json({ error: 'period or periodStart/periodEnd is required' }, { status: 400 })
    }

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } })
    if (!employee) return Response.json({ error: 'Employee not found' }, { status: 404 })

    const basicSalary = employee.salary
    const totalAllowances = allowances || 0
    const totalDeductions = deductions || 0
    const grossSalary = basicSalary + totalAllowances
    const effectiveTaxRate = Number(taxRate ?? 0)
    const taxAmount = grossSalary * (effectiveTaxRate / 100)
    const netSalary = grossSalary - totalDeductions - taxAmount

    const payrollNo = await getNextSequence('PAYROLL', 'PRL-')

    const payroll = await prisma.payrollEntry.create({
      data: {
        payrollNo,
        employeeId,
        period: period || start.toLocaleString('en', { month: 'long', year: 'numeric' }),
        periodStart: start,
        periodEnd: end,
        basicSalary,
        allowances: totalAllowances,
        deductions: totalDeductions,
        taxAmount,
        netSalary,
        notes,
        lines: {
          create: [
            { type: 'EARNING', description: 'Basic Salary', amount: basicSalary },
            ...(totalAllowances > 0 ? [{ type: 'EARNING', description: 'Allowances', amount: totalAllowances }] : []),
            ...(totalDeductions > 0 ? [{ type: 'DEDUCTION', description: 'Deductions', amount: totalDeductions }] : []),
            ...(taxAmount > 0 ? [{ type: 'DEDUCTION', description: 'Tax', amount: taxAmount }] : []),
          ],
        },
      },
      include: { employee: { select: { name: true } }, lines: true },
    })

    const companyId = await resolveCompanyId()
    await maybeStartWorkflow({
      entityType: 'PAYROLL',
      entityId: payroll.id,
      entityLabel: payroll.payrollNo,
      amount: netSalary,
      departmentId: employee.departmentId ?? null,
      submittedById: user.id,
      companyId,
    })

    return Response.json(payroll, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('payroll.view', handleGet)
export const POST = guarded('payroll.manage', handlePost)
