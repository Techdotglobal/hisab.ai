import 'server-only'
import { createHash } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'

type Row = Record<string, unknown>
const QUICKBOOKS_MAPPING_VERSION='2026-08-02-operational-v4'

function sourcePayloadHash(raw:Row,entityType:string){
  const mappingVersion=entityType==='Item'?`${QUICKBOOKS_MAPPING_VERSION}:`:''
  return createHash('sha256').update(`${mappingVersion}${JSON.stringify(raw)}`).digest('hex')
}

export function parseQuickBooksRaw(row: Row): Row {
  if (typeof row._quickbooksRaw === 'string') {
    try { return JSON.parse(row._quickbooksRaw) as Row } catch { return {} }
  }
  return row._quickbooksRaw && typeof row._quickbooksRaw === 'object' ? row._quickbooksRaw as Row : row
}

function collectRelationships(value: unknown, path = '', output: Array<{ path: string; type?: string; value: string; name?: string }> = []) {
  if (Array.isArray(value)) value.forEach((item, index) => collectRelationships(item, `${path}[${index}]`, output))
  else if (value && typeof value === 'object') {
    const object = value as Row
    if ((path.endsWith('Ref') || path.includes('LinkedTxn')) && (object.value ?? object.TxnId)) {
      output.push({ path, type: String(object.type ?? object.TxnType ?? ''), value: String(object.value ?? object.TxnId), name: object.name ? String(object.name) : undefined })
    }
    for (const [key, child] of Object.entries(object)) collectRelationships(child, path ? `${path}.${key}` : key, output)
  }
  return output
}

/** QuickBooks source id for a mapped row (raw Id wins, then the normalized aliases). */
export function quickBooksSourceIdOf(row: Row): string {
  const raw = parseQuickBooksRaw(row)
  return String(raw.Id ?? row._quickbooksId ?? row.sourceId ?? '')
}

/**
 * Key for the {@link QuickBooksMigrationPageState} maps. QuickBooks reuses small
 * integer ids across entity types (Account "2", Customer "2", Vendor "2" all
 * exist), and `quickbooks_migration_records` is keyed by
 * `(company, realm, entity_type, source_id)` — so the page-state maps MUST be
 * keyed by `(entityType, sourceId)`, never `sourceId` alone, or a link check
 * for Customer "2" can read the Account "2" row and wrongly report
 * "linked to an unexpected native record".
 */
function pageStateKey(entityType: string, sourceId: string): string {
  return `${entityType}::${sourceId}`
}

interface MigrationRecordInput { companyId: string; realmId: string; entityType: string; row: Row; localTable?: string; localId?: string; partition?: string }

/**
 * Builds the `quickbooks_migration_records` row for one source record. Shared by
 * the per-record and batch archive paths so both persist byte-identical rows.
 * `local_id` / `imported_at` / `local_table` / `extraction_partition` are only
 * emitted when supplied, so a source-only archive never clobbers a link written
 * by a later pass.
 */
function buildMigrationRecordRow(input: MigrationRecordInput) {
  const raw = parseQuickBooksRaw(input.row)
  const sourceId = String(raw.Id ?? input.row._quickbooksId ?? input.row.sourceId ?? '')
  if (!sourceId) throw new Error(`QuickBooks ${input.entityType} record is missing Id.`)
  const metadata = raw.MetaData && typeof raw.MetaData === 'object' ? raw.MetaData as Row : {}
  return {
    sourceId,
    raw,
    record: {
      company_id: input.companyId,
      realm_id: input.realmId,
      entity_type: input.entityType,
      source_id: sourceId,
      sync_token: raw.SyncToken === undefined ? null : String(raw.SyncToken),
      source_created_at: metadata.CreateTime ?? null,
      source_updated_at: metadata.LastUpdatedTime ?? null,
      is_active: raw.Active === undefined ? null : Boolean(raw.Active),
      is_deleted: String(raw.status ?? '').toLowerCase() === 'deleted',
      source_payload: raw,
      payload_hash: sourcePayloadHash(raw,input.entityType),
      relationships: collectRelationships(raw),
      custom_fields: Array.isArray(raw.CustomField) ? raw.CustomField : [],
      currency_code: raw.CurrencyRef && typeof raw.CurrencyRef === 'object' ? String((raw.CurrencyRef as Row).value ?? '') || null : null,
      exchange_rate: raw.ExchangeRate === undefined ? null : Number(raw.ExchangeRate),
      ...(input.localTable !== undefined ? { local_table:input.localTable } : {}),
      ...(input.localId !== undefined ? { local_id:input.localId, imported_at:new Date().toISOString() } : {}),
      ...(input.partition !== undefined ? { extraction_partition:input.partition } : {}),
      updated_at: new Date().toISOString(),
    },
  }
}

function localLinkRow(input: { companyId: string; realmId: string; entityType: string; sourceId: string; localTable: string; localId: string }) {
  return { company_id:input.companyId, realm_id:input.realmId, entity_type:input.entityType, source_id:input.sourceId, local_table:input.localTable, local_id:input.localId, updated_at:new Date().toISOString() }
}

type CurrencyWork = { entityType: string; sourceId: string; raw: Row; currencyCode: string; exchangeRate: number | null }

function archiveExchangeRateRow(companyId: string, home: string, work: CurrencyWork): { key: string; row: Record<string, unknown> } | null {
  const metadata = work.raw.MetaData && typeof work.raw.MetaData === 'object' ? work.raw.MetaData as Row : {}
  const date = String(work.raw.TxnDate ?? work.raw.TxnDateTime ?? metadata.CreateTime ?? '').slice(0,10)
  if (!home || work.currencyCode === home || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  return {
    key: `${work.currencyCode}|${home}|${date}`,
    row: { company_id:companyId, from_currency:work.currencyCode, to_currency:home, rate:work.exchangeRate, effective_date:`${date}T00:00:00.000Z`, source:'QUICKBOOKS_TRANSACTION', is_manual_override:true, notes:`QuickBooks ${work.entityType} ${work.sourceId}` },
  }
}

async function persistArchiveCurrency(companyId: string, entityType: string, sourceId: string, raw: Row, currencyCode: string, exchangeRate: number | null) {
  const currency = await createAdminClient().from('company_currencies').upsert({ company_id:companyId, code:currencyCode, name:currencyCode, is_primary:false, is_active:true }, { onConflict:'company_id,code' })
  if (currency.error) throw currency.error
  if (exchangeRate && Number(exchangeRate) > 0) {
    const company = await createAdminClient().from('companies').select('currency').eq('id',companyId).single()
    if (company.error) throw company.error
    const built = archiveExchangeRateRow(companyId, String(company.data.currency ?? '').toUpperCase(), { entityType, sourceId, raw, currencyCode, exchangeRate })
    if (built) {
      const rate = await createAdminClient().from('exchange_rates').upsert(built.row, { onConflict:'company_id,from_currency,to_currency,effective_date' })
      if (rate.error) throw rate.error
    }
  }
}

/**
 * Batched form of {@link persistArchiveCurrency}: one `company_currencies` upsert
 * for the page's distinct currency codes, one `companies` read, and one
 * `exchange_rates` upsert for the distinct (from,to,date) tuples — instead of the
 * per-record fan-out that live profiling showed dominating master-data archiving
 * (`company_currencies` was ~2 calls/record for accounts and customers).
 */
async function persistArchiveCurrenciesBatch(companyId: string, works: CurrencyWork[]) {
  if (works.length === 0) return
  const db = createAdminClient()
  const codes = [...new Set(works.map((work) => work.currencyCode))]
  const currency = await db.from('company_currencies').upsert(codes.map((code) => ({ company_id:companyId, code, name:code, is_primary:false, is_active:true })), { onConflict:'company_id,code' })
  if (currency.error) throw currency.error
  const rateWorks = works.filter((work) => work.exchangeRate && Number(work.exchangeRate) > 0)
  if (rateWorks.length === 0) return
  const company = await db.from('companies').select('currency').eq('id',companyId).single()
  if (company.error) throw company.error
  const home = String(company.data.currency ?? '').toUpperCase()
  const rateRows = new Map<string, Record<string, unknown>>()
  for (const work of rateWorks) {
    const built = archiveExchangeRateRow(companyId, home, work)
    if (built && !rateRows.has(built.key)) rateRows.set(built.key, built.row)
  }
  if (rateRows.size) {
    const rates = await db.from('exchange_rates').upsert([...rateRows.values()], { onConflict:'company_id,from_currency,to_currency,effective_date' })
    if (rates.error) throw rates.error
  }
}

export async function archiveQuickBooksRecord(input: MigrationRecordInput) {
  const { sourceId, raw, record } = buildMigrationRecordRow(input)
  const { data, error } = await createAdminClient().from('quickbooks_migration_records').upsert(record, { onConflict: 'company_id,realm_id,entity_type,source_id' }).select('*').single()
  if (error) throw error
  if (record.currency_code) {
    await persistArchiveCurrency(input.companyId, input.entityType, sourceId, raw, record.currency_code, record.exchange_rate)
  }
  if (input.localId && input.localTable) {
    const linked = await createAdminClient().from('quickbooks_migration_local_links').upsert(localLinkRow({ companyId:input.companyId, realmId:input.realmId, entityType:input.entityType, sourceId, localTable:input.localTable, localId:input.localId }), { onConflict:'company_id,realm_id,entity_type,source_id,local_table,local_id' })
    if (linked.error) throw linked.error
  }
  return data
}

export interface QuickBooksMigrationRecordState {
  payloadHash: string | null
  localId: string | null
  localTable: string | null
  importedAt: string | null
  entityType: string
}

export interface QuickBooksMigrationPageState {
  records: Map<string, QuickBooksMigrationRecordState>
  links: Map<string, Array<{ localTable: string; localId: string }>>
}

/**
 * One-shot read of the migration-tracking rows for an entire page of source ids.
 * Replaces the per-record `quickbooks_migration_records` /
 * `quickbooks_migration_local_links` reads that `isQuickBooksRecordUnchanged`
 * and `assertQuickBooksRecordLinked` do individually. Two IN queries per page.
 */
export async function loadQuickBooksMigrationPageState(
  companyId: string,
  realmId: string,
  sourceIds: string[],
  entityType?: string,
): Promise<QuickBooksMigrationPageState> {
  const unique = [...new Set(sourceIds.filter(Boolean))]
  const state: QuickBooksMigrationPageState = { records: new Map(), links: new Map() }
  if (unique.length === 0) return state
  const db = createAdminClient()
  const CHUNK = 200
  for (let index = 0; index < unique.length; index += CHUNK) {
    const slice = unique.slice(index, index + CHUNK)
    let recordQuery = db.from('quickbooks_migration_records').select('source_id,payload_hash,local_id,local_table,imported_at,entity_type').eq('company_id', companyId).eq('realm_id', realmId).in('source_id', slice)
    if (entityType) recordQuery = recordQuery.eq('entity_type', entityType)
    const records = await recordQuery
    if (records.error) throw records.error
    for (const row of records.data ?? []) {
      // Keyed by (entity_type, source_id): QuickBooks reuses ids across entities.
      state.records.set(pageStateKey(String(row.entity_type ?? ''), String(row.source_id)), {
        payloadHash: row.payload_hash === null || row.payload_hash === undefined ? null : String(row.payload_hash),
        localId: row.local_id ? String(row.local_id) : null,
        localTable: row.local_table ? String(row.local_table) : null,
        importedAt: row.imported_at ? String(row.imported_at) : null,
        entityType: String(row.entity_type ?? ''),
      })
    }
    let linkQuery = db.from('quickbooks_migration_local_links').select('source_id,local_table,local_id,entity_type').eq('company_id', companyId).eq('realm_id', realmId).in('source_id', slice)
    if (entityType) linkQuery = linkQuery.eq('entity_type', entityType)
    const links = await linkQuery
    if (links.error) throw links.error
    for (const row of links.data ?? []) {
      const key = pageStateKey(String(row.entity_type ?? ''), String(row.source_id))
      const list = state.links.get(key) ?? []
      list.push({ localTable: String(row.local_table), localId: String(row.local_id) })
      state.links.set(key, list)
    }
  }
  return state
}

export interface QuickBooksArchiveBatchEntry { realmId: string; entityType: string; row: Row; localTable?: string; localId?: string; partition?: string }

/**
 * Multi-row upsert of `quickbooks_migration_records` (and, for entries that
 * carry a native id, `quickbooks_migration_local_links`) for a whole page.
 * Behaviour matches `archiveQuickBooksRecord` per row — same builder, same
 * conflict targets, same currency side-effects — just batched. Idempotent: a
 * replayed page upserts the same rows.
 */
export async function archiveQuickBooksRecordsBatch(companyId: string, entries: QuickBooksArchiveBatchEntry[]): Promise<void> {
  if (entries.length === 0) return
  const db = createAdminClient()
  const recordRows: Array<Record<string, unknown>> = []
  const linkRows: Array<Record<string, unknown>> = []
  const currencyWork: CurrencyWork[] = []
  for (const entry of entries) {
    const { sourceId, raw, record } = buildMigrationRecordRow({ companyId, realmId: entry.realmId, entityType: entry.entityType, row: entry.row, localTable: entry.localTable, localId: entry.localId, partition: entry.partition })
    recordRows.push(record)
    if (record.currency_code) currencyWork.push({ entityType: entry.entityType, sourceId, raw, currencyCode: record.currency_code, exchangeRate: record.exchange_rate })
    if (entry.localId && entry.localTable) {
      linkRows.push(localLinkRow({ companyId, realmId: entry.realmId, entityType: entry.entityType, sourceId, localTable: entry.localTable, localId: entry.localId }))
    }
  }
  const records = await db.from('quickbooks_migration_records').upsert(recordRows, { onConflict: 'company_id,realm_id,entity_type,source_id' })
  if (records.error) throw records.error
  if (linkRows.length) {
    const links = await db.from('quickbooks_migration_local_links').upsert(linkRows, { onConflict: 'company_id,realm_id,entity_type,source_id,local_table,local_id' })
    if (links.error) throw links.error
  }
  await persistArchiveCurrenciesBatch(companyId, currencyWork)
}

/**
 * Pure page-level equivalent of `assertQuickBooksRecordLinked`, verified against
 * a pre-loaded {@link QuickBooksMigrationPageState}. Returns null when the row is
 * durably linked to `expectedLocalId`, otherwise the failure message. No I/O.
 */
export function verifyQuickBooksRecordLinked(row: Row, expectedLocalId: string, state: QuickBooksMigrationPageState): string | null {
  const entityType = String(row._quickbooksEntity ?? '')
  const sourceId = quickBooksSourceIdOf(row)
  if (!entityType || !sourceId) return null
  const key = pageStateKey(entityType, sourceId)
  const record = state.records.get(key)
  if (!record?.localId || !record.localTable || !record.importedAt) return `QuickBooks ${entityType} ${sourceId} was preserved but did not complete native materialization.`
  if (record.localId !== expectedLocalId) return `QuickBooks ${entityType} ${sourceId} linked to an unexpected native record.`
  const links = state.links.get(key) ?? []
  if (!links.some((link) => link.localTable === record.localTable && link.localId === expectedLocalId)) return `QuickBooks ${entityType} ${sourceId} has no durable native migration link.`
  return null
}

/** Whether a source row is unchanged & materialized, judged from pre-loaded page state (no I/O). */
export function isQuickBooksRecordUnchangedInState(row: Row, state: QuickBooksMigrationPageState): boolean {
  const entityType = String(row._quickbooksEntity ?? '')
  const sourceId = quickBooksSourceIdOf(row)
  if (!entityType || !sourceId) return false
  const record = state.records.get(pageStateKey(entityType, sourceId))
  if (!record?.localId || !record.importedAt) return false
  return record.payloadHash === sourcePayloadHash(parseQuickBooksRaw(row), entityType)
}

export async function isQuickBooksRecordUnchanged(companyId:string,row:Row):Promise<boolean>{
  const realmId=String(row._realmId??''),entityType=String(row._quickbooksEntity??''),sourceId=String(row._quickbooksId??row.sourceId??'')
  if(!realmId||!entityType||!sourceId)return false
  const raw=parseQuickBooksRaw(row),payloadHash=sourcePayloadHash(raw,entityType)
  const existing=await createAdminClient().from('quickbooks_migration_records').select('payload_hash,local_id,imported_at').eq('company_id',companyId).eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId).maybeSingle()
  if(existing.error)throw existing.error
  return Boolean(existing.data?.local_id&&existing.data.imported_at&&existing.data.payload_hash===payloadHash)
}

export async function linkArchivedQuickBooksRecord(input: { companyId: string; realmId: string; entityType: string; sourceId: string; localTable: string; localId: string }) {
  const { error } = await createAdminClient().from('quickbooks_migration_records').update({ local_table: input.localTable, local_id: input.localId, imported_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('company_id', input.companyId).eq('realm_id', input.realmId).eq('entity_type', input.entityType).eq('source_id', input.sourceId)
  if (error) throw error
  const linked = await createAdminClient().from('quickbooks_migration_local_links').upsert({ company_id:input.companyId, realm_id:input.realmId, entity_type:input.entityType, source_id:input.sourceId, local_table:input.localTable, local_id:input.localId, updated_at:new Date().toISOString() }, { onConflict:'company_id,realm_id,entity_type,source_id,local_table,local_id' })
  if (linked.error) throw linked.error
}

export async function assertQuickBooksRecordLinked(companyId:string,row:Row,expectedLocalId:string){
  const realmId=String(row._realmId??''),entityType=String(row._quickbooksEntity??''),sourceId=String(row._quickbooksId??row.sourceId??'')
  if(!realmId||!entityType||!sourceId)return
  const db=createAdminClient()
  const record=await db.from('quickbooks_migration_records').select('local_id,local_table,imported_at').eq('company_id',companyId).eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId).maybeSingle()
  if(record.error)throw record.error
  if(!record.data?.local_id||!record.data.local_table||!record.data.imported_at)throw new Error(`QuickBooks ${entityType} ${sourceId} was preserved but did not complete native materialization.`)
  if(String(record.data.local_id)!==expectedLocalId)throw new Error(`QuickBooks ${entityType} ${sourceId} linked to an unexpected native record.`)
  const link=await db.from('quickbooks_migration_local_links').select('id').eq('company_id',companyId).eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId).eq('local_table',record.data.local_table).eq('local_id',expectedLocalId).maybeSingle()
  if(link.error)throw link.error
  if(!link.data)throw new Error(`QuickBooks ${entityType} ${sourceId} has no durable native migration link.`)
}

export async function recordQuickBooksWarning(input: { companyId: string; realmId: string; resourceKey: string; sourceId?: string; code: string; message: string; details?: Row }) {
  const { error } = await createAdminClient().from('quickbooks_migration_warnings').insert({ company_id: input.companyId, realm_id: input.realmId, resource_key: input.resourceKey, source_id: input.sourceId ?? null, code: input.code, message: input.message, details: input.details ?? {} })
  if (error) throw error
}

export async function findArchivedRecord(companyId: string, realmId: string, entityType: string, sourceId: string) {
  const { data, error } = await createAdminClient().from('quickbooks_migration_records').select('id,local_id,local_table,payload_hash,sync_token,is_deleted').eq('company_id', companyId).eq('realm_id', realmId).eq('entity_type', entityType).eq('source_id', sourceId).maybeSingle()
  if (error) throw error
  return data
}

// Positive-result-only cache: a resolved (found) link is safe to reuse for the rest of this process's lifetime,
// since nothing in an import run un-links an already-migrated record. A miss is never cached, so a dependency that
// gets linked later in the same run (or a genuinely-unresolvable reference) is always re-checked against the
// database rather than risking a stale "not found". This lookup was previously uncached and called once per line
// reference (account/item/class/etc.), which dominated materialization time for transaction modules with many lines
// per record (measured ~265 DB queries per journal-entries record).
const quickBooksLocalIdCache = new Map<string, { id: string; table: string }>()
export async function resolveQuickBooksLocalId(companyId: string, realmId: string, sourceId: string, entityTypes?: string[], localTables?: string[]) {
  const cacheKey = `${companyId}:${realmId}:${sourceId}:${(entityTypes ?? []).slice().sort().join(',')}:${(localTables ?? []).slice().sort().join(',')}`
  const cached = quickBooksLocalIdCache.get(cacheKey)
  if (cached) return cached
  let query = createAdminClient().from('quickbooks_migration_records').select('local_id,local_table').eq('company_id', companyId).eq('realm_id', realmId).eq('source_id', sourceId).not('local_id', 'is', null).limit(1)
  if (entityTypes?.length) query = query.in('entity_type', entityTypes)
  if (localTables?.length) query = query.in('local_table', localTables)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  if(data){ const resolved={ id: String(data.local_id), table: String(data.local_table) }; quickBooksLocalIdCache.set(cacheKey,resolved); return resolved }
  let linkQuery = createAdminClient().from('quickbooks_migration_local_links').select('local_id,local_table').eq('company_id',companyId).eq('realm_id',realmId).eq('source_id',sourceId).order('updated_at',{ascending:false}).limit(1)
  if (entityTypes?.length) linkQuery = linkQuery.in('entity_type',entityTypes)
  if (localTables?.length) linkQuery = linkQuery.in('local_table',localTables)
  const linked = await linkQuery.maybeSingle()
  if (linked.error) throw linked.error
  if (!linked.data) return null
  const resolved = { id:String(linked.data.local_id), table:String(linked.data.local_table) }
  quickBooksLocalIdCache.set(cacheKey,resolved)
  return resolved
}

export async function resolveQuickBooksCustomerContext(companyId:string,realmId:string,sourceId:string) {
  const direct=await resolveQuickBooksLocalId(companyId,realmId,sourceId,['Customer'],['customers'])
  const project=await resolveQuickBooksLocalId(companyId,realmId,sourceId,['Customer'],['cost_centers'])
  if(direct)return {customerId:direct.id,projectId:project?.id??null}
  const archived=await createAdminClient().from('quickbooks_migration_records').select('source_payload').eq('company_id',companyId).eq('realm_id',realmId).eq('entity_type','Customer').eq('source_id',sourceId).maybeSingle()
  if(archived.error)throw archived.error
  const payload=(archived.data?.source_payload??{}) as Row
  const parent=payload.ParentRef&&typeof payload.ParentRef==='object'?String((payload.ParentRef as Row).value??''):''
  const customer=parent?await resolveQuickBooksLocalId(companyId,realmId,parent,['Customer'],['customers']):null
  return customer?{customerId:customer.id,projectId:project?.id??null}:null
}

export async function resolveQuickBooksInventoryItemId(companyId:string,realmId:string,sourceId:string) {
  const archived=await createAdminClient().from('quickbooks_migration_records').select('source_payload').eq('company_id',companyId).eq('realm_id',realmId).eq('entity_type','Item').eq('source_id',sourceId).maybeSingle()
  if(archived.error)throw archived.error
  const payload=(archived.data?.source_payload??{}) as Row
  if(String(payload.Type??'').toLowerCase()!=='inventory')return null
  return resolveQuickBooksLocalId(companyId,realmId,sourceId,['Item'],['inventory_items'])
}

export async function materializeQuickBooksCustomFields(input: { companyId:string; entityType:string; entityId:string; row:Row }) {
  const raw = parseQuickBooksRaw(input.row)
  const fields = Array.isArray(raw.CustomField) ? raw.CustomField as Row[] : []
  const db = createAdminClient()
  for (const field of fields) {
    const fieldKey = String(field.DefinitionId ?? field.Name ?? '').trim()
    if (!fieldKey) continue
    const label = String(field.Name ?? `QuickBooks field ${fieldKey}`)
    const type = field.Type === 'NumberType' ? 'NUMBER' : field.Type === 'DateType' ? 'DATE' : field.Type === 'BooleanType' ? 'BOOLEAN' : 'TEXT'
    const definition = await db.from('custom_field_definitions').upsert({ company_id:input.companyId, entity_type:input.entityType, field_key:`quickbooks_${fieldKey}`, field_label:label, field_type:type, is_required:false }, { onConflict:'company_id,entity_type,field_key' }).select('id').single()
    if (definition.error) throw definition.error
    const rawValue = field.StringValue ?? field.NumberValue ?? field.DateValue ?? field.BooleanValue
    const stored = await db.from('custom_field_values').upsert({ company_id:input.companyId, definition_id:definition.data.id, entity_id:input.entityId, value:rawValue === undefined || rawValue === null ? null : String(rawValue) }, { onConflict:'definition_id,entity_id' })
    if (stored.error) throw stored.error
  }
}

export async function applyQuickBooksDeletion(companyId:string, realmId:string, entityType:string, sourceId:string) {
  const db = createAdminClient()
  const links = await db.from('quickbooks_migration_local_links').select('local_table,local_id').eq('company_id',companyId).eq('realm_id',realmId).eq('entity_type',entityType).eq('source_id',sourceId)
  if (links.error) throw links.error
  const softDelete = new Set(['customers','vendors','inventory_items','chart_of_accounts','cost_centers','employees','departments'])
  const deleteOnly = new Set(['time_activities','recurring_transaction_templates'])
  const inactiveOnly = new Set(['tax_rates','payment_terms','company_currencies'])
  for (const link of links.data ?? []) {
    if (softDelete.has(link.local_table)) {
      const result = await db.from(link.local_table).update({ is_active:false, deleted_at:new Date().toISOString() }).eq('company_id',companyId).eq('id',link.local_id)
      if (result.error) throw result.error
    } else if (deleteOnly.has(link.local_table)) {
      const result = await db.from(link.local_table).update({ deleted_at:new Date().toISOString() }).eq('company_id',companyId).eq('id',link.local_id)
      if (result.error) throw result.error
    } else if (inactiveOnly.has(link.local_table)) {
      const result = await db.from(link.local_table).update({ is_active:false }).eq('company_id',companyId).eq('id',link.local_id)
      if (result.error) throw result.error
    }
  }
}
