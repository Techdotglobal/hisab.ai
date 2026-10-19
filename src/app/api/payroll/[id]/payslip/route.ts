import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { getPayrollRepository } from '@/lib/db/provider'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const { id } = await params
    const payroll = await getPayrollRepository().findById(id)
    if (!payroll) return Response.json({ error: 'Not found' }, { status: 404 })

    const payslip = {
      payrollNo: payroll.payrollNo,
      employee: payroll.employee,
      period: payroll.period,
      periodStart: payroll.periodStart,
      periodEnd: payroll.periodEnd,
      status: payroll.status,
      earnings: payroll.lines?.filter((l) => l.type === 'EARNING') ?? [],
      deductions: payroll.lines?.filter((l) => l.type === 'DEDUCTION') ?? [],
      basicSalary: payroll.basicSalary,
      allowances: payroll.allowances,
      deductionsTotal: payroll.deductions,
      taxAmount: payroll.taxAmount,
      netSalary: payroll.netSalary,
      generatedAt: new Date().toISOString(),
    }

    const accept = _req.headers.get('accept') ?? ''
    if (accept.includes('application/pdf')) {
      const text = [
        `Payslip ${payslip.payrollNo}`,
        `Employee: ${payslip.employee?.name ?? 'N/A'}`,
        `Period: ${payslip.period}`,
        `Basic: ${payslip.basicSalary}`,
        `Allowances: ${payslip.allowances}`,
        `Deductions: ${payslip.deductionsTotal}`,
        `Tax: ${payslip.taxAmount}`,
        `Net: ${payslip.netSalary}`,
      ].join('\n')

      return new Response(text, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="payslip-${payslip.payrollNo}.pdf"`,
        },
      })
    }

    return Response.json(payslip)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('payroll.view', handleGet)
