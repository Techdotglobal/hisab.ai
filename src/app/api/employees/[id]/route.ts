import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const employee = await prisma.employee.findUnique({
      where: { id, companyId },
      include: { payrollEntries: { orderBy: { periodStart: 'desc' }, take: 5 } },
    })
    if (!employee) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(employee)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    const body = await request.json()
    const employee = await prisma.employee.update({
      where: { id, companyId },
      data: {
        name: body.name,
        email: body.email,
        phone: body.phone,
        department: body.department,
        position: body.position,
        joiningDate: body.joiningDate ? new Date(body.joiningDate) : undefined,
        salary: body.salary,
        salaryType: body.salaryType,
        bankAccount: body.bankAccount,
        isActive: body.isActive,
      },
    })
    return Response.json(employee)
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { id } = await params
    await prisma.employee.delete({ where: { id, companyId } })
    return Response.json({ success: true })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('employees.view', handleGet)
export const PUT = guarded('employees.manage', handlePut)
export const DELETE = guarded('employees.manage', handleDelete)
