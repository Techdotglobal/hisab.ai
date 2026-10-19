import { requireAuth } from '@/lib/auth'
import { guarded } from '@/lib/permissions/guard'
import { getCustomerRepository } from '@/lib/db/provider'
import type {
  CustomerBalanceFilter,
  CustomerListOptions,
  CustomerVatFilter,
} from '@/lib/db/repositories/customer.repository.interface'

function pickBool(searchParams: URLSearchParams, key: string): boolean | undefined {
  const value = searchParams.get(key)
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

const VAT_FILTERS = new Set<CustomerVatFilter>(['has_vat', 'no_vat', 'valid_trn', 'invalid_trn'])
const BALANCE_FILTERS = new Set<CustomerBalanceFilter>(['outstanding', 'zero', 'credit', 'over_limit'])
const SORT_FIELDS = new Set<CustomerListOptions['sortBy']>([
  'name',
  'createdAt',
  'updatedAt',
  'outstanding',
  'creditLimit',
  'city',
  'country',
])

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)

    const vatRaw = searchParams.get('vatFilter') ?? ''
    const balanceRaw = searchParams.get('balanceFilter') ?? ''
    const sortRaw = searchParams.get('sortBy') ?? 'name'

    const vatFilter = VAT_FILTERS.has(vatRaw as CustomerVatFilter)
      ? (vatRaw as CustomerVatFilter)
      : undefined
    const balanceFilter = BALANCE_FILTERS.has(balanceRaw as CustomerBalanceFilter)
      ? (balanceRaw as CustomerBalanceFilter)
      : undefined
    const sortBy = SORT_FIELDS.has(sortRaw as CustomerListOptions['sortBy'])
      ? (sortRaw as CustomerListOptions['sortBy'])
      : 'name'

    const options: CustomerListOptions = {
      search: searchParams.get('search') ?? undefined,
      country: searchParams.get('country') ?? undefined,
      city: searchParams.get('city') ?? undefined,
      vatFilter,
      balanceFilter,
      hasVat: pickBool(searchParams, 'hasVat'),
      hasOutstanding: pickBool(searchParams, 'hasOutstanding'),
      creditLimitExceeded: searchParams.get('creditLimitExceeded') === 'true' ? true : undefined,
      sortBy,
      sortDir: searchParams.get('sortDir') === 'desc' ? 'desc' : 'asc',
    }

    const customers = await getCustomerRepository().findMany(options)
    return Response.json(customers)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''

    if (!name) {
      return Response.json({ error: 'Customer name is required' }, { status: 400 })
    }

    const customer = await getCustomerRepository().create({
      name,
      email: body.email,
      phone: body.phone,
      address: body.address,
      city: body.city,
      country: body.country,
      taxId: body.taxId,
      creditLimit: body.creditLimit || 0,
      paymentTerms: body.paymentTerms || 30,
    })
    return Response.json(customer, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('customers.view', handleGet)
export const POST = guarded('customers.edit', handlePost)
