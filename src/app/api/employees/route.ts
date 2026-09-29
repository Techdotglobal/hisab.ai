import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getNextSequence } from '@/lib/sequences'
import { resolveCompanyId } from '@/lib/tenant'

export async function GET(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search') ?? ''

    const employees = await prisma.employee.findMany({
      where: {
        AND: [
          { companyId },
          search ? {
            OR: [
              { name: { contains: search } },
              { employeeNo: { contains: search } },
              { department: { contains: search } },
            ],
          } : {},
        ],
      },
      orderBy: { name: 'asc' },
    })

    return Response.json(employees)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''

    if (!name || !body.joiningDate) {
      return Response.json({ error: 'name and joiningDate are required' }, { status: 400 })
    }

    const employeeNo = await getNextSequence('EMPLOYEE', 'EMP-')

    const employee = await prisma.employee.create({
      data: {
        employeeNo,
        name,
        email: body.email,
        phone: body.phone,
        department: body.department,
        position: body.position,
        joiningDate: new Date(body.joiningDate),
        salary: body.salary || 0,
        salaryType: body.salaryType || 'MONTHLY',
        bankAccount: body.bankAccount,
      },
    })

    return Response.json(employee, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
