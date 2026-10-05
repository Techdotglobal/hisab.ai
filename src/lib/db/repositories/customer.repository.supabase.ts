import 'server-only'
import { isSaudiVatTrn } from '@/lib/customers/vat'
import { mapCustomerRow, mapInvoiceRow } from '../entity-mappers'
import type { CustomerRecord } from '../entities'
import { fetchAllRows, queryByIdOrLegacy, resolveCompanyId, supabaseDb } from '../repository-utils'
import { resolveSequenceRepository } from '../sequence-resolver'
import type {
  CustomerBatchDuplicateInput,
  CustomerBatchDuplicateMatch,
  CustomerCreateInput,
  CustomerDuplicateCriteria,
  CustomerListOptions,
  CustomerRepository,
  CustomerUpdateInput,
} from './customer.repository.interface'

const OPEN_STATUSES = ['SENT', 'PARTIAL', 'OVERDUE']

async function attachOutstanding(
  customers: CustomerRecord[],
  companyId: string,
): Promise<CustomerRecord[]> {
  if (customers.length === 0) return customers
  const db = supabaseDb()
  const ids = customers.map((c) => c.id)
  const { data: invoices, error } = await fetchAllRows(() =>
    db
      .from('invoices')
      .select('customer_id, balance, status')
      .eq('company_id', companyId)
      .in('customer_id', ids)
      .is('deleted_at', null)
      .order('id', { ascending: true }),
  )

  if (error) throw error

  return customers.map((c) => {
    const related = (invoices ?? []).filter((i) => i.customer_id === c.id)
    const outstandingBalance = related
      .filter((i) => OPEN_STATUSES.includes(String(i.status)))
      .reduce((s, i) => s + Number(i.balance), 0)
    return { ...c, outstandingBalance }
  })
}

async function resolveCustomerUuid(id: string, companyId: string): Promise<string | null> {
  const row = await queryByIdOrLegacy(supabaseDb(), 'customers', id, companyId)
  return row ? String(row.id) : null
}

export const supabaseCustomerRepository: CustomerRepository = {
  async findMany(options: CustomerListOptions = {}) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const search = options.search?.trim()

    let query = db
      .from('customers')
      .select('*')
      .eq('company_id', companyId)
      .is('deleted_at', null)

    if (search) {
      query = query.or(
        `name.ilike.%${search}%,email.ilike.%${search}%,customer_no.ilike.%${search}%,phone.ilike.%${search}%,tax_id.ilike.%${search}%`,
      )
    }
    if (options.country) query = query.eq('country', options.country)
    if (options.city) query = query.eq('city', options.city)

    if (options.vatFilter === 'has_vat' || options.hasVat === true) {
      query = query.not('tax_id', 'is', null).neq('tax_id', '')
    } else if (options.vatFilter === 'no_vat' || options.hasVat === false) {
      query = query.or('tax_id.is.null,tax_id.eq.')
    }

    const sortAsc = options.sortDir === 'asc'
    const sortBy = options.sortBy ?? 'name'

    if (sortBy === 'createdAt') {
      query = query.order('created_at', { ascending: sortAsc })
    } else if (sortBy === 'updatedAt') {
      query = query.order('updated_at', { ascending: sortAsc })
    } else if (sortBy === 'creditLimit') {
      query = query.order('credit_limit', { ascending: sortAsc })
    } else if (sortBy === 'city') {
      query = query.order('city', { ascending: sortAsc, nullsFirst: false })
    } else if (sortBy === 'country') {
      query = query.order('country', { ascending: sortAsc })
    } else {
      query = query.order('name', { ascending: sortBy === 'name' ? sortAsc : true })
    }

    const { data, error } = await query
    if (error) throw error

    let customers = (data ?? []).map(mapCustomerRow)
    if (options.includeOutstanding !== false) {
      customers = await attachOutstanding(customers, companyId)
    }

    if (options.vatFilter === 'valid_trn') {
      customers = customers.filter((c) => Boolean(c.taxId?.trim()) && isSaudiVatTrn(c.taxId!))
    } else if (options.vatFilter === 'invalid_trn') {
      customers = customers.filter((c) => Boolean(c.taxId?.trim()) && !isSaudiVatTrn(c.taxId!))
    }

    const balanceFilter = options.balanceFilter
    if (balanceFilter === 'outstanding' || options.hasOutstanding === true) {
      customers = customers.filter((c) => (c.outstandingBalance ?? 0) > 0)
    } else if (balanceFilter === 'zero' || options.hasOutstanding === false) {
      customers = customers.filter((c) => (c.outstandingBalance ?? 0) === 0)
    } else if (balanceFilter === 'credit') {
      customers = customers.filter((c) => (c.outstandingBalance ?? 0) < 0)
    } else if (balanceFilter === 'over_limit' || options.creditLimitExceeded) {
      customers = customers.filter(
        (c) => (c.outstandingBalance ?? 0) > (c.creditLimit ?? 0) && (c.creditLimit ?? 0) > 0,
      )
    }

    if (sortBy === 'outstanding') {
      customers.sort((a, b) => {
        const cmp = (a.outstandingBalance ?? 0) - (b.outstandingBalance ?? 0)
        return sortAsc ? cmp : -cmp
      })
    }

    return customers
  },

  async getFilterFacets() {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const { data, error } = await db
      .from('customers')
      .select('country, city')
      .eq('company_id', companyId)
      .is('deleted_at', null)

    if (error) throw error

    const citiesByCountry: Record<string, Set<string>> = {}
    const countrySet = new Set<string>()

    for (const row of data ?? []) {
      const country = String(row.country ?? '').trim()
      const city = String(row.city ?? '').trim()
      if (!country) continue
      countrySet.add(country)
      if (!citiesByCountry[country]) citiesByCountry[country] = new Set()
      if (city) citiesByCountry[country].add(city)
    }

    return {
      countries: [...countrySet].sort((a, b) => a.localeCompare(b)),
      citiesByCountry: Object.fromEntries(
        Object.entries(citiesByCountry).map(([country, cities]) => [
          country,
          [...cities].sort((a, b) => a.localeCompare(b)),
        ]),
      ),
    }
  },

  async findDuplicate(criteria: CustomerDuplicateCriteria) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()

    const email = criteria.email?.trim()
    if (email) {
      const { data, error } = await db
        .from('customers')
        .select('*')
        .eq('company_id', companyId)
        .ilike('email', email)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle()
      if (error) throw error
      if (data) return mapCustomerRow(data)
    }

    const taxId = criteria.taxId?.trim()
    if (taxId) {
      const { data, error } = await db
        .from('customers')
        .select('*')
        .eq('company_id', companyId)
        .eq('tax_id', taxId)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle()
      if (error) throw error
      if (data) return mapCustomerRow(data)
    }

    const name = criteria.name?.trim()
    if (name) {
      const { data, error } = await db
        .from('customers')
        .select('*')
        .eq('company_id', companyId)
        .ilike('name', name)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle()
      if (error) throw error
      if (data) return mapCustomerRow(data)
    }

    return null
  },

  async findDuplicatesBatch(inputs: CustomerBatchDuplicateInput[]) {
    if (inputs.length === 0) return []

    const db = supabaseDb()
    const companyId = await resolveCompanyId()

    const taxIds = [...new Set(inputs.map((item) => item.taxId?.trim()).filter(Boolean) as string[])]
    const emails = [...new Set(inputs.map((item) => item.email?.trim().toLowerCase()).filter(Boolean) as string[])]
    const names = [...new Set(inputs.map((item) => item.name?.trim().toLowerCase()).filter(Boolean) as string[])]

    const byTaxId = new Map<string, CustomerRecord>()
    const byEmail = new Map<string, CustomerRecord>()
    const byName = new Map<string, CustomerRecord>()

    if (taxIds.length > 0) {
      const { data, error } = await db
        .from('customers')
        .select('*')
        .eq('company_id', companyId)
        .in('tax_id', taxIds)
        .is('deleted_at', null)
      if (error) throw error
      for (const row of data ?? []) {
        const customer = mapCustomerRow(row)
        if (customer.taxId) byTaxId.set(customer.taxId, customer)
      }
    }

    const needsEmailOrName = emails.length > 0 || names.length > 0
    if (needsEmailOrName) {
      const { data, error } = await db
        .from('customers')
        .select('id, email, tax_id, name')
        .eq('company_id', companyId)
        .is('deleted_at', null)
      if (error) throw error

      const emailSet = new Set(emails)
      const nameSet = new Set(names)

      for (const row of data ?? []) {
        const customer = mapCustomerRow(row)
        if (customer.email && emailSet.has(customer.email.toLowerCase())) {
          byEmail.set(customer.email.toLowerCase(), customer)
        }
        if (nameSet.has(customer.name.toLowerCase())) {
          byName.set(customer.name.toLowerCase(), customer)
        }
      }
    }

    const matches: CustomerBatchDuplicateMatch[] = []
    for (const input of inputs) {
      const email = input.email?.trim().toLowerCase()
      const taxId = input.taxId?.trim()
      const name = input.name?.trim().toLowerCase()

      let existing: CustomerRecord | undefined
      const matchedOn: string[] = []

      if (email && byEmail.has(email)) {
        existing = byEmail.get(email)
        matchedOn.push('email')
      } else if (taxId && byTaxId.has(taxId)) {
        existing = byTaxId.get(taxId)
        matchedOn.push('taxId')
      } else if (name && byName.has(name)) {
        existing = byName.get(name)
        matchedOn.push('name')
      }

      if (existing) {
        matches.push({
          rowNumber: input.rowNumber,
          existingId: existing.id,
          matchedOn: matchedOn.length ? matchedOn : ['name'],
        })
      }
    }

    return matches
  },

  async findById(id: string) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const row = await queryByIdOrLegacy(db, 'customers', id, companyId)
    if (!row) return null

    const customer = mapCustomerRow(row)
    const { data: invoices, error } = await db
      .from('invoices')
      .select('*')
      .eq('company_id', companyId)
      .eq('customer_id', customer.id)
      .is('deleted_at', null)
      .order('date', { ascending: false })
      .limit(10)

    if (error) throw error
    return {
      ...customer,
      invoices: (invoices ?? []).map(mapInvoiceRow),
    } as CustomerRecord
  },

  async create(input: CustomerCreateInput) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const customerNo = await resolveSequenceRepository().next('CUSTOMER', 'CUST-')

    const { data, error } = await db
      .from('customers')
      .insert({
        company_id: companyId,
        customer_no: customerNo,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        city: input.city ?? null,
        country: input.country ?? null,
        tax_id: input.taxId ?? null,
        credit_limit: input.creditLimit ?? 0,
        payment_terms: input.paymentTerms ?? 30,
        is_active: input.isActive ?? true,
      })
      .select('*')
      .single()

    if (error) throw error
    return mapCustomerRow(data)
  },

  async update(id: string, input: CustomerUpdateInput) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const customerId = await resolveCustomerUuid(id, companyId)
    if (!customerId) throw new Error('Customer not found')

    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.email !== undefined) patch.email = input.email
    if (input.phone !== undefined) patch.phone = input.phone
    if (input.address !== undefined) patch.address = input.address
    if (input.city !== undefined) patch.city = input.city
    if (input.country !== undefined) patch.country = input.country
    if (input.taxId !== undefined) patch.tax_id = input.taxId
    if (input.creditLimit !== undefined) patch.credit_limit = input.creditLimit
    if (input.paymentTerms !== undefined) patch.payment_terms = input.paymentTerms
    if (input.isActive !== undefined) patch.is_active = input.isActive

    const { data, error } = await db
      .from('customers')
      .update(patch)
      .eq('id', customerId)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .select('*')
      .single()

    if (error) throw error
    return mapCustomerRow(data)
  },

  async delete(id: string) {
    const db = supabaseDb()
    const companyId = await resolveCompanyId()
    const customerId = await resolveCustomerUuid(id, companyId)
    if (!customerId) throw new Error('Customer not found')

    const { error } = await db
      .from('customers')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', customerId)
      .eq('company_id', companyId)

    if (error) throw error
  },
}
