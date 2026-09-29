import 'server-only'
/* eslint-disable @typescript-eslint/no-explicit-any, prefer-const */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from './supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

type AnyRecord = Record<string, any>

const MODEL_TABLES: Record<string, string> = {
  appSession: 'auth.sessions',
  bill: 'bills',
  billLine: 'bill_lines',
  chartOfAccount: 'chart_of_accounts',
  companySettings: 'company_settings',
  costCenter: 'cost_centers',
  customer: 'customers',
  employee: 'employees',
  expense: 'expenses',
  expenseLine: 'expense_lines',
  inventoryItem: 'inventory_items',
  invoice: 'invoices',
  invoiceLine: 'invoice_lines',
  journalEntry: 'journal_entries',
  journalLine: 'journal_lines',
  payment: 'payments',
  payrollEntry: 'payroll_entries',
  payrollLine: 'payroll_lines',
  receipt: 'receipts',
  sequence: 'sequences',
  taxRate: 'tax_rates',
  user: 'profiles',
  vendor: 'vendors',
  vendorCredit: 'vendor_credits',
  zatcaAuditLog: 'zatca_audit_logs',
  zatcaCredential: 'zatca_credentials',
  zatcaOnboardingRequest: 'zatca_onboarding_requests',
  zatcaSandboxTestRun: 'zatca_sandbox_test_runs',
}

const RELATIONS: Record<string, Record<string, { table: string; local: string; foreign: string; many?: boolean }>> = {
  bill: {
    vendor: { table: 'vendors', local: 'vendor_id', foreign: 'id' },
    lines: { table: 'bill_lines', local: 'id', foreign: 'bill_id', many: true },
    payments: { table: 'payments', local: 'id', foreign: 'bill_id', many: true },
  },
  expense: {
    lines: { table: 'expense_lines', local: 'id', foreign: 'expense_id', many: true },
    receipt: { table: 'receipts', local: 'receipt_id', foreign: 'id' },
  },
  invoice: {
    customer: { table: 'customers', local: 'customer_id', foreign: 'id' },
    lines: { table: 'invoice_lines', local: 'id', foreign: 'invoice_id', many: true },
    payments: { table: 'payments', local: 'id', foreign: 'invoice_id', many: true },
  },
  journalEntry: {
    lines: { table: 'journal_lines', local: 'id', foreign: 'journal_id', many: true },
  },
  journalLine: {
    account: { table: 'chart_of_accounts', local: 'account_id', foreign: 'id' },
    costCenter: { table: 'cost_centers', local: 'cost_center_id', foreign: 'id' },
    journal: { table: 'journal_entries', local: 'journal_id', foreign: 'id' },
  },
  payment: {
    invoice: { table: 'invoices', local: 'invoice_id', foreign: 'id' },
    bill: { table: 'bills', local: 'bill_id', foreign: 'id' },
    customer: { table: 'customers', local: 'customer_id', foreign: 'id' },
    vendor: { table: 'vendors', local: 'vendor_id', foreign: 'id' },
    allocations: { table: 'payment_allocations', local: 'id', foreign: 'payment_id', many: true },
  },
  vendorCredit: {
    vendor: { table: 'vendors', local: 'vendor_id', foreign: 'id' },
  },
  payrollEntry: {
    employee: { table: 'employees', local: 'employee_id', foreign: 'id' },
    lines: { table: 'payroll_lines', local: 'id', foreign: 'payroll_id', many: true },
  },
  receipt: {
    uploadedBy: { table: 'profiles', local: 'uploaded_by_id', foreign: 'id' },
  },
}

const LINE_RELATIONS: Record<string, { table: string; fk: string }> = {
  bill: { table: 'bill_lines', fk: 'bill_id' },
  expense: { table: 'expense_lines', fk: 'expense_id' },
  invoice: { table: 'invoice_lines', fk: 'invoice_id' },
  journalEntry: { table: 'journal_lines', fk: 'journal_id' },
  payrollEntry: { table: 'payroll_lines', fk: 'payroll_id' },
}

const FIELD_OVERRIDES: Record<string, string> = {
  invoiceUUID: 'invoice_uuid',
}

function snake(key: string): string {
  if (FIELD_OVERRIDES[key]) return FIELD_OVERRIDES[key]
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
}

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function toSnakeDeep(value: any): any {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toSnakeDeep)
  if (!value || typeof value !== 'object') return value

  const out: AnyRecord = {}
  for (const [key, val] of Object.entries(value)) {
    if (key === 'lines' || key === 'payments') continue
    out[snake(key)] = toSnakeDeep(val)
  }
  return out
}

function toCamelDeep(value: any): any {
  if (Array.isArray(value)) return value.map(toCamelDeep)
  if (!value || typeof value !== 'object') return value

  const out: AnyRecord = {}
  for (const [key, val] of Object.entries(value)) {
    out[camel(key)] = toCamelDeep(val)
  }
  return out
}

function normalizeData(data: AnyRecord): AnyRecord {
  const normalized = toSnakeDeep(data)
  delete normalized.id
  return normalized
}

function splitUpdateOperators(data: AnyRecord) {
  const row: AnyRecord = {}
  const operators: Array<{ field: string; op: 'increment' | 'decrement'; amount: number }> = []

  for (const [key, value] of Object.entries(data)) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && !(value instanceof Date)
      && ('increment' in value || 'decrement' in value)
    ) {
      const op = 'increment' in value ? 'increment' : 'decrement'
      operators.push({ field: key, op, amount: Number((value as AnyRecord)[op] ?? 0) })
    } else {
      row[key] = value
    }
  }

  return { row, operators }
}

async function addCompanyId(row: AnyRecord, table: string) {
  if ('company_id' in row || table === 'profiles') return row
  row.company_id = await resolveCompanyId()
  return row
}

// Builds one `column.operator.value` fragment for a PostgREST `.or()`/`.not()` filter string.
// Returns null for a condition this flat-table shim cannot express as a single column comparison
// (e.g. a nested relation filter like `{ vendor: { name: { contains } } }`) rather than throwing,
// since that would otherwise silently be attempted as a bogus column named after the relation.
function toFilterFragment(rawKey: string, rawValue: unknown): string | null {
  const key = snake(rawKey)
  const value = rawValue as any
  const escape = (v: unknown) => String(v).replace(/[,()]/g, (m) => `\\${m}`)
  if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
    if ('contains' in value) return `${key}.ilike.%${escape(value.contains)}%`
    if ('equals' in value) return `${key}.eq.${escape(value.equals)}`
    if ('in' in value && Array.isArray(value.in)) return `${key}.in.(${value.in.map(escape).join(',')})`
    if ('not' in value) return `${key}.neq.${escape(value.not)}`
    if ('gte' in value) return `${key}.gte.${escape(value.gte instanceof Date ? value.gte.toISOString() : value.gte)}`
    if ('lte' in value) return `${key}.lte.${escape(value.lte instanceof Date ? value.lte.toISOString() : value.lte)}`
    if ('gt' in value) return `${key}.gt.${escape(value.gt instanceof Date ? value.gt.toISOString() : value.gt)}`
    if ('lt' in value) return `${key}.lt.${escape(value.lt instanceof Date ? value.lt.toISOString() : value.lt)}`
    return null
  }
  if (value === null) return `${key}.is.null`
  return `${key}.eq.${escape(value instanceof Date ? value.toISOString() : value)}`
}

// Flattens a Prisma-style OR array into the top-level field conditions this shim can express as
// PostgREST filter fragments, skipping any nested relation filter it can't (see toFilterFragment).
function orFragments(conditions: AnyRecord[]): string[] {
  const fragments: string[] = []
  for (const condition of conditions) {
    for (const [key, value] of Object.entries(condition)) {
      if (value === undefined) continue
      const fragment = toFilterFragment(key, value)
      if (fragment) fragments.push(fragment)
    }
  }
  return fragments
}

function applyWhere(query: any, where?: AnyRecord) {
  if (!where) return query

  for (const [rawKey, rawValue] of Object.entries(where)) {
    if (rawValue === undefined) continue

    // Prisma's AND/OR/NOT combinators have no column of their own — snake-casing them like an
    // ordinary field (AND -> `_a_n_d`) sent a query for a nonexistent column and failed every
    // caller that filters this way (e.g. the Expenses/Bills list APIs, which always wrap their
    // filter in `{ AND: [...] }` even with no search/status selected).
    if (rawKey === 'AND' && Array.isArray(rawValue)) {
      for (const condition of rawValue) query = applyWhere(query, condition)
      continue
    }
    if (rawKey === 'OR' && Array.isArray(rawValue)) {
      const fragments = orFragments(rawValue)
      if (fragments.length) query = query.or(fragments.join(','))
      continue
    }
    if (rawKey === 'NOT' && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      for (const [key, value] of Object.entries(rawValue as AnyRecord)) {
        if (value === undefined) continue
        const fragment = toFilterFragment(key, value)
        if (!fragment) continue
        const [, operator, ...rest] = fragment.split('.')
        query = query.not(snake(key), operator, rest.join('.'))
      }
      continue
    }

    const key = snake(rawKey)
    const value = rawValue as any

    if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      if ('contains' in value) query = query.ilike(key, `%${String(value.contains)}%`)
      else if ('equals' in value) query = query.eq(key, value.equals)
      else if ('in' in value && Array.isArray(value.in)) query = query.in(key, value.in)
      else if ('not' in value) query = query.neq(key, value.not)
      else {
        if ('gte' in value) query = query.gte(key, value.gte instanceof Date ? value.gte.toISOString() : value.gte)
        if ('lte' in value) query = query.lte(key, value.lte instanceof Date ? value.lte.toISOString() : value.lte)
        if ('gt' in value) query = query.gt(key, value.gt instanceof Date ? value.gt.toISOString() : value.gt)
        if ('lt' in value) query = query.lt(key, value.lt instanceof Date ? value.lt.toISOString() : value.lt)
      }
      continue
    }

    if (value === null) query = query.is(key, null)
    else query = query.eq(key, value instanceof Date ? value.toISOString() : value)
  }

  return query
}

function applyOrder(query: any, orderBy?: AnyRecord | AnyRecord[]) {
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
  for (const order of orders) {
    for (const [key, direction] of Object.entries(order)) {
      query = query.order(snake(key), { ascending: direction !== 'desc' })
    }
  }
  return query
}

function applySelect(row: any, select?: AnyRecord) {
  if (!row || !select) return row
  const out: AnyRecord = {}
  for (const [key, enabled] of Object.entries(select)) {
    if (enabled) out[key] = row[key]
  }
  return out
}

async function attachIncludes(model: string, row: any, include?: AnyRecord, client: SupabaseClient = createAdminClient()) {
  if (!row || !include) return row
  const relations = RELATIONS[model] ?? {}
  const out = { ...row }

  for (const [name, enabled] of Object.entries(include)) {
    if (!enabled || !relations[name]) continue
    const relation = relations[name]
    const localValue = row[camel(relation.local)]
    if (!localValue) {
      out[name] = relation.many ? [] : null
      continue
    }

    let query = client.from(relation.table).select('*').eq(relation.foreign, localValue)
    if (relation.many) {
      const { data, error } = await query
      if (error) throw error
      out[name] = toCamelDeep(data ?? [])
    } else {
      const { data, error } = await query.maybeSingle()
      if (error) throw error
      out[name] = data ? toCamelDeep(data) : null
    }
  }

  return out
}

function sumRows(rows: AnyRecord[], field: string) {
  return rows.reduce((sum, row) => sum + Number(row[snake(field)] ?? 0), 0)
}

function delegate(model: string) {
  const table = MODEL_TABLES[model]
  if (!table) throw new Error(`Unknown Supabase model: ${model}`)

  return {
    async findMany(args: AnyRecord = {}) {
      const client = createAdminClient()
      let query = client.from(table).select('*')
      query = applyWhere(query, args.where)
      query = applyOrder(query, args.orderBy)
      if (args.take) query = query.limit(args.take)

      const { data, error } = await query
      if (error) throw error

      const rows = await Promise.all((data ?? []).map(async (row) => attachIncludes(model, toCamelDeep(row), args.include, client)))
      return args.select ? rows.map((row) => applySelect(row, args.select)) : rows
    },

    async findFirst(args: AnyRecord = {}) {
      const rows = await this.findMany({ ...args, take: 1 })
      return rows[0] ?? null
    },

    async findUnique(args: AnyRecord = {}) {
      return this.findFirst(args)
    },

    async count(args: AnyRecord = {}) {
      let query = createAdminClient().from(table).select('id', { count: 'exact', head: true })
      query = applyWhere(query, args.where)
      const { count, error } = await query
      if (error) throw error
      return count ?? 0
    },

    async aggregate(args: AnyRecord = {}) {
      const rows = await this.findMany({ where: args.where })
      const result: AnyRecord = {}
      if (args._sum) {
        result._sum = {}
        for (const field of Object.keys(args._sum)) result._sum[field] = sumRows(rows.map(toSnakeDeep), field)
      }
      if (args._count) result._count = rows.length
      return result
    },

    async groupBy(args: AnyRecord = {}) {
      const by = Array.isArray(args.by) ? args.by : [args.by]
      const rows = await this.findMany({ where: args.where })
      const groups = new Map<string, AnyRecord[]>()

      for (const row of rows) {
        const key = by.map((field) => String(row[field] ?? '')).join('\u001f')
        const bucket = groups.get(key) ?? []
        bucket.push(row)
        groups.set(key, bucket)
      }

      return [...groups.values()].map((bucket) => {
        const out: AnyRecord = {}
        for (const field of by) out[field] = bucket[0][field]
        if (args._count) out._count = bucket.length
        if (args._sum) {
          out._sum = {}
          for (const field of Object.keys(args._sum)) {
            out._sum[field] = bucket.reduce((sum, row) => sum + Number(row[field] ?? 0), 0)
          }
        }
        return out
      })
    },

    async create(args: AnyRecord) {
      const client = createAdminClient()
      const data = args.data ?? args
      const nestedLines = data.lines?.create ?? data.lines
      const row = await addCompanyId(normalizeData(data), table)

      const { data: inserted, error } = await client.from(table).insert(row).select('*').single()
      if (error) throw error

      const relation = LINE_RELATIONS[model]
      if (relation && Array.isArray(nestedLines) && nestedLines.length > 0) {
        const lineRows = await Promise.all(
          nestedLines.map(async (line: AnyRecord) => ({
            ...(await addCompanyId(normalizeData(line), relation.table)),
            [relation.fk]: inserted.id,
          })),
        )
        const { error: lineError } = await client.from(relation.table).insert(lineRows)
        if (lineError) throw lineError
      }

      const camelRow = toCamelDeep(inserted)
      return attachIncludes(model, camelRow, args.include, client)
    },

    async createMany(args: AnyRecord) {
      const rows = await Promise.all((args.data ?? []).map(async (row: AnyRecord) => addCompanyId(normalizeData(row), table)))
      if (rows.length === 0) return { count: 0 }
      const { error } = await createAdminClient().from(table).insert(rows)
      if (error) throw error
      return { count: rows.length }
    },

    async update(args: AnyRecord) {
      const client = createAdminClient()
      const data = args.data ?? {}
      const nestedLines = data.lines?.create ?? data.lines
      const { row: plainData, operators } = splitUpdateOperators(data)
      let row = normalizeData(plainData)

      if (operators.length > 0) {
        const existing = await this.findUnique({ where: args.where })
        if (!existing) throw new Error(`${model} record not found`)
        for (const operator of operators) {
          const current = Number(existing[operator.field] ?? 0)
          row[snake(operator.field)] = operator.op === 'increment'
            ? current + operator.amount
            : current - operator.amount
        }
      }

      let query = client.from(table).update(row).select('*')
      query = applyWhere(query, args.where)
      const { data: updated, error } = await query.single()
      if (error) throw error

      const relation = LINE_RELATIONS[model]
      if (relation && Array.isArray(nestedLines)) {
        await client.from(relation.table).delete().eq(relation.fk, updated.id)
        if (nestedLines.length > 0) {
          const lineRows = await Promise.all(
            nestedLines.map(async (line: AnyRecord) => ({
              ...(await addCompanyId(normalizeData(line), relation.table)),
              [relation.fk]: updated.id,
            })),
          )
          const { error: lineError } = await client.from(relation.table).insert(lineRows)
          if (lineError) throw lineError
        }
      }

      return attachIncludes(model, toCamelDeep(updated), args.include, client)
    },

    async upsert(args: AnyRecord) {
      const existing = await this.findUnique({ where: args.where })
      if (existing) return this.update({ where: args.where, data: args.update, include: args.include })
      return this.create({ data: { ...(args.create ?? {}), ...(args.where ?? {}) }, include: args.include })
    },

    async delete(args: AnyRecord) {
      const client = createAdminClient()
      const existing = await this.findUnique({ where: args.where })
      let query = client.from(table).delete()
      query = applyWhere(query, args.where)
      const { error } = await query
      if (error) throw error
      return existing
    },

    async deleteMany(args: AnyRecord = {}) {
      let query = createAdminClient().from(table).delete()
      query = applyWhere(query, args.where)
      const { error } = await query
      if (error) throw error
      return { count: 0 }
    },
  }
}

export const prisma = new Proxy({} as any, {
  get(_target, prop) {
    if (prop === '$disconnect') return async () => undefined
    return delegate(String(prop))
  },
})

export default prisma
