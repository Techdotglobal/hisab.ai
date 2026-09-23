import { createHash } from 'node:crypto'
import type { AccountingProvider, ProviderAccessContext, ProviderEntityFetchOptions } from '@/integrations/accounting/contracts/accounting-provider'
import { quickBooksErrorStatus } from '@/integrations/accounting/providers/quickbooks/quickbooks-integration.service'
import { extractQuickBooksPaymentRelationships } from '../quickbooks/payment-relationships'
import {
  companyCurrencyCodes,
  currentExchangeRateAsOfDate,
  exchangeRateAsOfDate,
  exchangeRateCurrencyPair,
  latestExchangeRateRows,
  quickBooksExchangeRateWhere,
} from '../quickbooks/exchange-rates'
import type { ImportSourceAdapter, ImportSourceFetchOptions, ImportSourceResource, NormalizedImportResource } from './types'

type JsonRecord = Record<string, unknown>

function object(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' ? value as JsonRecord : {}
}

function value(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'boolean' ? String(value) : String(value).trim()
}

function primaryEmailAddress(valueToNormalize: unknown): string {
  const addresses = value(valueToNormalize)
    .split(/[;,]/)
    .map((addressValue) => addressValue.trim())
    .filter(Boolean)

  return addresses.find((addressValue) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addressValue)) ?? ''
}

function address(record: JsonRecord): JsonRecord {
  return object(record.BillAddr ?? record.ShipAddr)
}

function contact(record: JsonRecord) {
  const location = address(record)
  return {
    name: value(record.DisplayName ?? record.CompanyName ?? record.FullyQualifiedName),
    // QuickBooks permits multiple comma/semicolon-separated addresses in its
    // single PrimaryEmailAddr value. Hisab's canonical contact field stores
    // one address; the untouched source value remains in _quickbooksRaw.
    email: primaryEmailAddress(object(record.PrimaryEmailAddr).Address),
    phone: value(object(record.PrimaryPhone).FreeFormNumber),
    address: [location.Line1, location.Line2].map(value).filter(Boolean).join(', '),
    city: value(location.City),
    country: value(location.Country),
    taxId: value(record.TaxIdentifier),
    paymentTerms: value(object(record.TermRef).name).match(/\d+/)?.[0] ?? '30',
    isActive: value(record.Active ?? true),
  }
}

export const RESOURCES: ImportSourceResource[] = [
  { key: 'accounts', label: 'Chart of Accounts', moduleKey: 'accounts' },
  { key: 'customers', label: 'Customers', moduleKey: 'customers' },
  { key: 'vendors', label: 'Vendors', moduleKey: 'vendors' },
  { key: 'items', label: 'Products & Services', moduleKey: 'inventory' },
  { key: 'tax-codes', label: 'Tax Codes', moduleKey: 'tax-rates' },
  { key: 'payment-terms', label: 'Payment Terms', moduleKey: 'payment-terms' },
  { key: 'invoices', label: 'Invoices', moduleKey: 'invoices' },
  { key: 'bills', label: 'Bills', moduleKey: 'bills' },
  { key: 'expenses', label: 'Expenses', moduleKey: 'expenses' },
  { key: 'journal-entries', label: 'Journal Entries', moduleKey: 'journal-entries' },
  { key: 'sales-receipts', label: 'Sales Receipts', moduleKey: 'sales-receipts' },
  { key: 'purchase-orders', label: 'Purchase Orders', moduleKey: 'purchase-orders' },
  { key: 'vendor-credits', label: 'Supplier Credits', moduleKey: 'vendor-credits' },
  { key: 'estimates', label: 'Estimates', moduleKey: 'estimates' },
  { key: 'customer-payments', label: 'Customer Payments', moduleKey: 'customer-payments' },
  { key: 'vendor-payments', label: 'Vendor Payments', moduleKey: 'vendor-payments' },
  { key: 'projects', label: 'Projects', moduleKey: 'qb-projects' },
  { key: 'budgets', label: 'Budgets', moduleKey: 'qb-budgets' },
  { key: 'exchange-rates', label: 'Exchange Rates', moduleKey: 'qb-exchange-rates' },
  { key: 'classes', label: 'Classes', moduleKey: 'qb-classes' },
  { key: 'departments', label: 'Departments', moduleKey: 'qb-departments' },
  { key: 'employees', label: 'Employees', moduleKey: 'qb-employees' },
  { key: 'time-activities', label: 'Time Activities', moduleKey: 'qb-time-activities' },
  { key: 'credit-memos', label: 'Credit Memos', moduleKey: 'qb-credit-memos' },
  { key: 'deposits', label: 'Deposits', moduleKey: 'qb-deposits' },
  { key: 'transfers', label: 'Transfers', moduleKey: 'qb-transfers' },
  { key: 'inventory-adjustments', label: 'Inventory Adjustments', moduleKey: 'qb-inventory-adjustments' },
  { key: 'attachments', label: 'Attachments', moduleKey: 'qb-attachments' },
  { key: 'recurring-transactions', label: 'Recurring Transactions', moduleKey: 'qb-recurring-transactions' },
  { key: 'tax-agencies', label: 'Tax Agencies', moduleKey: 'qb-tax-agencies' },
  { key: 'tax-configurations', label: 'Tax Configuration', moduleKey: 'qb-tax-configurations' },
  { key: 'preferences', label: 'Company Preferences', moduleKey: 'qb-preferences' },
  { key: 'fixed-assets', label: 'Fixed Assets', moduleKey: 'qb-fixed-assets' },
]

export const QUICKBOOKS_ENTITY_BY_RESOURCE: Record<string, string> = {
  accounts:'Account', customers:'Customer', vendors:'Vendor', items:'Item', 'tax-codes':'TaxRate', 'payment-terms':'Term',
  invoices:'Invoice', bills:'Bill', expenses:'Purchase', 'journal-entries':'JournalEntry', 'sales-receipts':'SalesReceipt',
  'purchase-orders':'PurchaseOrder', 'vendor-credits':'VendorCredit', estimates:'Estimate', 'customer-payments':'Payment', 'vendor-payments':'BillPayment',
  projects: 'Customer', budgets: 'Budget', 'exchange-rates': 'ExchangeRate', classes: 'Class', departments: 'Department', employees: 'Employee',
  'time-activities': 'TimeActivity', 'credit-memos': 'CreditMemo', deposits: 'Deposit', transfers: 'Transfer',
  'inventory-adjustments': 'InventoryAdjustment', attachments: 'Attachable', 'recurring-transactions': 'RecurringTransaction', 'tax-agencies': 'TaxAgency',
  'tax-configurations': 'TaxCode', preferences:'Preferences', 'fixed-assets': 'Item',
}

// Current rates cover one row per enabled currency, so a single provider page
// holds the whole resource and the module needs no continuation chain.
const EXCHANGE_RATE_PAGE_SIZE = 1000

/**
 * Resolves the current-rate predicate for the ExchangeRate entity. Returns null
 * when the company has no queryable currencies, which means there is nothing to
 * import rather than a full historical extraction.
 */
async function resolveExchangeRateQuery(
  provider: AccountingProvider,
  context: ProviderAccessContext,
  signal?: AbortSignal,
): Promise<{ where: string; currencies: string[] } | null> {
  if (!provider.getEntityRecords) return null
  const currencies = companyCurrencyCodes(await provider.getEntityRecords(context, 'CompanyCurrency', {
    pageSize: EXCHANGE_RATE_PAGE_SIZE,
    maxRecords: EXCHANGE_RATE_PAGE_SIZE,
    signal,
  }))
  const where = quickBooksExchangeRateWhere(currencies, currentExchangeRateAsOfDate())
  return where ? { where, currencies } : null
}

export const PARTITIONED_RESOURCES = new Set([
  'invoices','bills','expenses','journal-entries','sales-receipts','purchase-orders','vendor-credits','estimates','customer-payments','vendor-payments',
  'credit-memos','deposits','transfers','inventory-adjustments',
])

const SPECIAL_PREVIEW_RESOURCES = new Set([
  'accounts', 'customers', 'vendors', 'items', 'tax-codes', 'payment-terms',
  'invoices', 'bills', 'expenses', 'journal-entries', 'sales-receipts',
  'purchase-orders', 'vendor-credits', 'estimates', 'customer-payments', 'vendor-payments',
  'preferences',
])

export function getQuickBooksPreviewSupport(resourceKey: string): { supported: boolean; message?: string } {
  const registered = RESOURCES.some((resource) => resource.key === resourceKey)
  if (!registered) return { supported: false, message: `QuickBooks resource ${resourceKey} has no adapter implementation.` }
  if (SPECIAL_PREVIEW_RESOURCES.has(resourceKey) || QUICKBOOKS_ENTITY_BY_RESOURCE[resourceKey]) return { supported: true }
  return { supported: false, message: `QuickBooks resource ${resourceKey} has no provider mapping or preview implementation.` }
}

export class QuickBooksImportAdapter implements ImportSourceAdapter {
  readonly key = 'quickbooks'
  readonly label = 'QuickBooks Online'
  readonly resources = RESOURCES

  async fetchResource(provider: AccountingProvider, context: ProviderAccessContext, resourceKey: string, options?: ImportSourceFetchOptions): Promise<NormalizedImportResource> {
    const resource = this.resources.find((item) => item.key === resourceKey)
    if (!resource) throw new Error(`Unsupported QuickBooks import resource: ${resourceKey}`)
    let hasMore = false
    const fetchEntity = async (entity:string,fallback:()=>Promise<unknown[]>,overrides?:Pick<ProviderEntityFetchOptions,'where'|'pageSize'>) => provider.getEntityRecords
      ? provider.getEntityRecords(context,entity,{
          includeInactive:true,
          partitioned:PARTITIONED_RESOURCES.has(resourceKey),
          startPosition:options?.resumeStartPosition,
          partitionStart:options?.partitionStart?new Date(options.partitionStart):undefined,
          partitionEnd:options?.partitionEnd?new Date(options.partitionEnd):undefined,
          maxPages: options?.boundedPage ? 1 : undefined,
          pageSize: overrides?.pageSize ?? (options?.boundedPage ? 100 : undefined),
          where: overrides?.where,
          retainRows:!options?.onBatch || options?.boundedPage,
          signal:options?.signal,
          onCheckpoint:options?.onCheckpoint?async checkpoint=>{hasMore=Boolean(checkpoint.hasMore||checkpoint.partitionComplete);return options.onCheckpoint!({...checkpoint,fetched:checkpoint.extractedCount})}:undefined,
          onPage:options?.onBatch?async(page,checkpoint)=>{hasMore=Boolean(checkpoint.hasMore||checkpoint.partitionComplete);return options.onBatch!(this.normalizeRecords(resourceKey,filterResourceRows(resourceKey,page),context.realmId),{...checkpoint,fetched:checkpoint.extractedCount})}:undefined,
        })
      : fallback()

    if (options?.preview) {
      const sampleSize = Math.min(25, Math.max(1, options.preview.sampleSize))
      if (resourceKey === 'preferences') {
        const sourceRows = provider.getPreferences ? await provider.getPreferences(context) : []
        const rows = this.normalizeRecords(resourceKey, sourceRows.slice(0, sampleSize), context.realmId)
        return { ...resource, rows, totalCount: sourceRows.length, countAccuracy: 'exact', sampled: true }
      }
      const entity = QUICKBOOKS_ENTITY_BY_RESOURCE[resourceKey]
      if (!entity || !provider.getEntityRecords) return { ...resource, rows: [], totalCount: 0, countAccuracy: 'exact', sampled: true }
      if (resourceKey === 'exchange-rates') {
        const query = await resolveExchangeRateQuery(provider, context, options.signal)
        if (!query) return { ...resource, rows: [], totalCount: 0, countAccuracy: 'exact', sampled: true }
        const rateCacheKey = `ExchangeRate:${query.where}:${sampleSize}`
        let pendingRates = options.preview.cache?.get(rateCacheKey)
        if (!pendingRates) {
          // QuickBooks rejects COUNT(*) for ExchangeRate, so the enabled
          // currency list is the count: one current rate per currency.
          pendingRates = provider.getEntityRecords(context, entity, { pageSize: sampleSize, maxRecords: sampleSize, where: query.where, signal: options.signal })
            .then((sample) => ({ count: query.currencies.length, rows: latestExchangeRateRows(sample) }))
          options.preview.cache?.set(rateCacheKey, pendingRates)
        }
        const rates = await pendingRates
        return {
          ...resource,
          rows: this.normalizeRecords(resourceKey, rates.rows.slice(0, sampleSize), context.realmId),
          totalCount: rates.count,
          countAccuracy: 'upper-bound',
          sampled: true,
        }
      }
      const where = resourceKey === 'projects' ? 'Job = true'
        : resourceKey === 'customers' ? 'Job = false'
        : resourceKey === 'fixed-assets' ? "Type = 'FixedAsset'"
          : undefined
      const cacheKey = `${entity}:${where ?? 'all'}:${sampleSize}:inactive`
      let pending = options.preview.cache?.get(cacheKey)
      if (!pending) {
        pending = Promise.all([
          provider.getEntityCount ? provider.getEntityCount(context, entity, { where }) : Promise.resolve<number | null>(null),
          provider.getEntityRecords(context, entity, { includeInactive:true, pageSize:sampleSize, maxRecords:sampleSize, where }),
        ]).then(([count, rows]) => ({ count: count ?? rows.length, rows })).catch((error) => {
          const status = quickBooksErrorStatus(error)
          if (resourceKey === 'fixed-assets' && status !== null && [400, 404, 405, 501].includes(status)) {
            console.warn('[quickbooks] Fixed Assets are unavailable for this company or edition; treating preview as zero records', JSON.stringify({ resourceKey, entity, where, status }))
            return { count: 0, rows: [] }
          }
          throw error
        })
        options.preview.cache?.set(cacheKey, pending)
      }
      const preview = await pending
      const sourceRows = filterResourceRows(resourceKey, preview.rows)
      const rows = this.normalizeRecords(resourceKey, sourceRows.slice(0, sampleSize), context.realmId)
      return { ...resource, rows, totalCount: preview.count, countAccuracy: 'exact', sampled: true }
    }

    let sourceRows: unknown[]
    switch (resourceKey) {
      case 'accounts': sourceRows = await fetchEntity('Account',()=>provider.getAccounts(context)); break
      case 'customers': sourceRows = await fetchEntity('Customer',()=>provider.getCustomers(context)); break
      case 'vendors': sourceRows = await fetchEntity('Vendor',()=>provider.getVendors(context)); break
      case 'items': sourceRows = await fetchEntity('Item',()=>provider.getItems(context)); break
      case 'tax-codes': sourceRows = await fetchEntity('TaxRate', () => provider.getTaxRates?.(context) ?? Promise.resolve([])); break
      case 'payment-terms': sourceRows = await fetchEntity('Term',()=>provider.getPaymentTerms(context)); break
      case 'invoices': sourceRows = await fetchEntity('Invoice',()=>provider.getInvoices(context)); break
      case 'bills': sourceRows = await fetchEntity('Bill',()=>provider.getBills(context)); break
      case 'expenses': sourceRows = await fetchEntity('Purchase',()=>provider.getExpenses?.(context)??Promise.resolve([])); break
      case 'journal-entries': sourceRows = await fetchEntity('JournalEntry',()=>provider.getJournalEntries?.(context)??Promise.resolve([])); break
      case 'sales-receipts': sourceRows = await fetchEntity('SalesReceipt',()=>provider.getSalesReceipts?.(context)??Promise.resolve([])); break
      case 'purchase-orders': sourceRows = await fetchEntity('PurchaseOrder',()=>provider.getPurchaseOrders?.(context)??Promise.resolve([])); break
      case 'vendor-credits': sourceRows = await fetchEntity('VendorCredit',()=>provider.getVendorCredits?.(context)??Promise.resolve([])); break
      case 'estimates': sourceRows = await fetchEntity('Estimate',()=>provider.getEstimates?.(context)??Promise.resolve([])); break
      case 'customer-payments': sourceRows = await fetchEntity('Payment',()=>provider.getCustomerPayments?.(context)??Promise.resolve([])); break
      case 'vendor-payments': sourceRows = await fetchEntity('BillPayment',()=>provider.getVendorPayments?.(context)??Promise.resolve([])); break
      case 'preferences': sourceRows = provider.getPreferences ? await provider.getPreferences(context) : []; break
      case 'exchange-rates': {
        const query = await resolveExchangeRateQuery(provider, context, options?.signal)
        if (!query) {
          // Nothing to extract. Report a terminal checkpoint so a resumed page
          // cursor cannot keep the continuation chain alive.
          const terminal = { startPosition: options?.resumeStartPosition ?? 1, fetched: 0, hasMore: false, partitionComplete: false }
          await options?.onBatch?.([], terminal)
          await options?.onCheckpoint?.(terminal)
          sourceRows = []
          break
        }
        sourceRows = await fetchEntity('ExchangeRate', async () => [], { where: query.where, pageSize: EXCHANGE_RATE_PAGE_SIZE })
        break
      }
      default: {
        const entity = QUICKBOOKS_ENTITY_BY_RESOURCE[resourceKey]
        if (!entity || !provider.getEntityRecords) sourceRows = []
        else sourceRows = await fetchEntity(entity,async()=>[])
      }
    }

    sourceRows = filterResourceRows(resourceKey, sourceRows)

    const rows = this.normalizeRecords(resourceKey, sourceRows, context.realmId)
    if (resourceKey === 'attachments' && provider.downloadAttachment && options?.companyId) {
      for (let index = 0; index < sourceRows.length; index += 5) {
        await Promise.all(sourceRows.slice(index, index + 5).map(async (item, batchIndex) => {
          const source = object(item)
          const id = value(source.Id)
          if (!id) return
          const download = await provider.downloadAttachment!(context, id)
          const response = download.content ? null : await fetch(download.url, { signal: AbortSignal.timeout(60_000) })
          if (response && !response.ok) throw new Error(`QuickBooks attachment ${id} download failed (${response.status}).`)
          const content = download.content ? new Uint8Array(download.content) : new Uint8Array(await response!.arrayBuffer())
          const fileName = value(source.FileName) || `quickbooks-${id}`
          const mimeType = download.contentType ?? response?.headers.get('content-type') ?? 'application/octet-stream'
          const { storeQuickBooksAttachment } = await import('../quickbooks/attachment-storage')
          const storagePath = await storeQuickBooksAttachment({ companyId:options.companyId!, realmId:context.realmId, id, fileName, mimeType, content })
          rows[index + batchIndex]._hisabAttachment = JSON.stringify({ storagePath, fileName, mimeType })
        }))
      }
    }
    return { ...resource, rows, hasMore }
  }

  normalizeRecords(resourceKey: string, sourceRows: unknown[], realmId: string): Record<string, string>[] {
    const rows: Record<string, string>[] = sourceRows.map((row) => {
      const source = object(row)
      const syntheticId = stableQuickBooksSourceId(resourceKey, source)
      return {
        ...this.normalize(resourceKey, source),
        sourceId: syntheticId,
        _quickbooksId: syntheticId,
        _quickbooksEntity: QUICKBOOKS_ENTITY_BY_RESOURCE[resourceKey] ?? resourceKey,
        _realmId: realmId,
        _syncToken: value(source.SyncToken),
        _quickbooksRaw: JSON.stringify(source),
        _quickbooksMeta: JSON.stringify(object(source.MetaData)),
        _quickbooksSyncToken: value(source.SyncToken),
        _quickbooksRelationships: JSON.stringify(Array.isArray(source.LinkedTxn) ? source.LinkedTxn : []),
        _quickbooksCustomFields: JSON.stringify(Array.isArray(source.CustomField) ? source.CustomField : []),
        _linkedTransactions: JSON.stringify(Array.isArray(source.LinkedTxn) ? source.LinkedTxn : []),
        _customFields: JSON.stringify(Array.isArray(source.CustomField) ? source.CustomField : []),
        _active: value(source.Active ?? true),
        _deleted: value(source.status).toLowerCase() === 'deleted' ? 'true' : 'false',
      }
    })
    if (resourceKey === 'accounts') {
      const accountNoById = new Map(sourceRows.map((item) => {
        const account = object(item)
        return [value(account.Id), value(account.AcctNum) || `QB-${value(account.Id)}`]
      }))
      sourceRows.forEach((item, index) => {
        const parentId = value(object(object(item).ParentRef).value)
        rows[index].parentNo = parentId ? accountNoById.get(parentId) ?? '' : ''
      })
    }
    return rows
  }

  private normalize(resourceKey: string, row: JsonRecord): Record<string, string> {
    switch (resourceKey) {
      case 'accounts': {
        return {
          accountNo: value(row.AcctNum) || `QB-${value(row.Id)}`,
          name: value(row.Name),
          fullName: value(row.FullyQualifiedName ?? row.Name),
          parentNo: '',
          accountType: value(row.AccountType),
          subType: value(row.AccountSubType ?? row.AccountType),
          description: value(row.Description),
          isActive: value(row.Active ?? true),
        }
      }
      case 'customers':
      case 'vendors': return contact(row)
      case 'items': return {
        name: value(row.Name),
        itemCode: value(row.Sku) || `QB-${value(row.Id)}`,
        description: value(row.Description ?? row.PurchaseDesc),
        category: value(row.Type) === 'Inventory' ? 'Products' : 'Services',
        unit: value(row.Type) === 'Inventory' ? 'PCS' : 'SVC',
        costPrice: value(row.PurchaseCost ?? 0),
        salePrice: value(row.UnitPrice ?? 0),
        quantity: value(row.QtyOnHand ?? 0),
        minQuantity: '0',
        isActive: value(row.Active ?? true),
      }
      case 'tax-codes': {
        // QuickBooks encodes reverse charge as a code pair — a positive rate
        // that adds output VAT and a negative "N-" counterpart that reverses
        // it. hisab.ai's `tax_rates` model requires a non-negative percentage
        // and carries the mechanism on `is_reverse_charge`, so the magnitude of
        // RateValue is the rate and SpecialTaxType drives the flag. Non
        // reverse-charge codes (NONE / ZERO_RATE / …) are unaffected.
        const rawRate = Number(value(row.RateValue ?? 0))
        return {
          name: value(row.Name),
          rate: value(Number.isFinite(rawRate) ? Math.abs(rawRate) : 0),
          type: 'VAT',
          isDefault: 'false',
          isReverseCharge: value(row.SpecialTaxType).toUpperCase() === 'REVERSE_CHARGE' ? 'true' : 'false',
          isActive: value(row.Active ?? true),
        }
      }
      case 'invoices':
      case 'bills':
      case 'expenses':
      case 'journal-entries':
      case 'sales-receipts':
      case 'purchase-orders':
      case 'vendor-credits':
      case 'estimates':
      case 'customer-payments':
      case 'vendor-payments': return normalizeTransaction(resourceKey, row)
      case 'payment-terms': return {
        name: value(row.Name),
        days: value(row.DueDays ?? 0),
        description: value(row.Type) || `Imported from QuickBooks (${value(row.Id)})`,
        isActive: value(row.Active ?? true),
      }
      default: return normalizeExtended(resourceKey, row)
    }
  }
}

export function filterResourceRows(resourceKey: string, sourceRows: unknown[]): unknown[] {
  // Historical rates are never imported, so anything older than the newest row
  // for a pair is dropped before staging even if QuickBooks returns a series.
  if (resourceKey === 'exchange-rates') return latestExchangeRateRows(sourceRows)
  if (!['projects','customers','fixed-assets','items'].includes(resourceKey)) return sourceRows
  return sourceRows.filter(item => {
    const row = object(item)
    const parentId = value(object(row.ParentRef).value)
    const isJob = row.Job === true || value(row.Job).toLowerCase() === 'true'
    if (resourceKey === 'projects') return isJob || Boolean(parentId)
    if (resourceKey === 'customers') return !isJob && !parentId
    const isFixedAsset = value(row.Type).toLowerCase() === 'fixedasset'
    return resourceKey === 'fixed-assets' ? isFixedAsset : !isFixedAsset
  })
}

function stableJson(valueToSerialize: unknown): string {
  if (Array.isArray(valueToSerialize)) return `[${valueToSerialize.map(stableJson).join(',')}]`
  if (valueToSerialize && typeof valueToSerialize === 'object') {
    return `{${Object.entries(valueToSerialize as JsonRecord).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(valueToSerialize) ?? 'null'
}

export function stableQuickBooksSourceId(resourceKey: string, source: JsonRecord): string {
  const nativeId = value(source.Id)
  if (nativeId) return nativeId
  if (resourceKey === 'preferences') return 'Preferences'
  if (resourceKey === 'exchange-rates') {
    const pair = exchangeRateCurrencyPair(source)
    const date = exchangeRateAsOfDate(source)
    if (pair && date) return `ExchangeRate:${pair.from}:${pair.to}:${date}`
  }
  const digest = createHash('sha256').update(`${resourceKey}:${stableJson(source)}`).digest('hex')
  return `${resourceKey}:${digest}`
}

function normalizeExtended(resourceKey: string, row: JsonRecord): Record<string, string> {
  const meta = object(row.MetaData)
  const currency = object(row.CurrencyRef)
  const parent = object(row.ParentRef)
  const entity = object(row.EntityRef)
  const account = object(row.AccountRef ?? row.AdjustmentAccountRef ?? row.AdjustAccountRef)
  return {
    sourceId: value(row.Id),
    name: value(row.DisplayName ?? row.Name ?? row.DocNumber ?? `${resourceKey}-${value(row.Id)}`),
    code: value(row.AcctNum ?? row.DocNumber ?? row.Sku) || `QB-${value(row.Id)}`,
    type: value(row.Type ?? row.TxnType ?? resourceKey),
    date: value(row.TxnDate ?? meta.CreateTime),
    updatedAt: value(meta.LastUpdatedTime),
    amount: value(row.TotalAmt ?? row.Amount ?? row.Rate ?? row.CurrentBalance ?? 0),
    currency: value(currency.value ?? currency.name),
    exchangeRate: value(row.ExchangeRate ?? row.Rate ?? 1),
    parentSourceId: value(parent.value),
    entitySourceId: value(entity.value),
    accountSourceId: value(account.value),
    status: value(row.TxnStatus ?? row.Status ?? (row.Active === false ? 'INACTIVE' : 'ACTIVE')),
    description: value(row.Description ?? row.PrivateNote ?? row.Note),
    lines: JSON.stringify(Array.isArray(row.Line) ? row.Line : []),
  }
}

function normalizeTransaction(resourceKey: string, row: JsonRecord): Record<string, string> {
  const customer = object(row.CustomerRef)
  const vendor = object(row.VendorRef)
  const entity = object(row.EntityRef)
  const transactionLines = Array.isArray(row.Line) ? row.Line : Array.isArray(row.JournalEntryLine) ? row.JournalEntryLine : []
  const linkedCandidates = [
    ...(Array.isArray(row.LinkedTxn) ? row.LinkedTxn : []),
    ...transactionLines.flatMap(line => Array.isArray(object(line).LinkedTxn) ? object(line).LinkedTxn as unknown[] : []),
  ]
  const linked = linkedCandidates.length ? object(linkedCandidates[0]) : {}
  const lines = transactionLines.map((line) => {
    const valueLine = object(line)
    const detailType = value(valueLine.DetailType)
    const detail = object(valueLine.SalesItemLineDetail ?? valueLine.PurchaseItemLineDetail ?? valueLine.ItemBasedExpenseLineDetail ?? valueLine.AccountBasedExpenseLineDetail ?? valueLine.JournalEntryLineDetail ?? valueLine.DiscountLineDetail)
    const item = object(detail.ItemRef)
    // ItemAccountRef is QuickBooks' resolved revenue/income account for a sales item line (SalesItemLineDetail nests it
    // alongside ItemRef); without it every invoice/credit-memo line fell through to the unordered accounts.revenue default.
    const account = object(detail.AccountRef ?? detail.DiscountAccountRef ?? detail.ItemAccountRef ?? valueLine.AccountRef)
    const quantity = Number(detail.Qty ?? 1)
    const rawAmount = Number(valueLine.Amount ?? 0)
    const amount = detailType === 'DiscountLineDetail' ? -Math.abs(rawAmount) : rawAmount
    const unitPrice = detail.UnitPrice ?? (detailType === 'SubTotalLineDetail' ? 0 : quantity ? amount / quantity : amount)
    return {
      sourceLineId: value(valueLine.Id),
      detailType,
      description: value(valueLine.Description),
      quantity: value(quantity),
      unitPrice: value(unitPrice),
      amount: value(amount),
      // TaxCodeRef is nested inside the detail object (e.g. SalesItemLineDetail.TaxCodeRef), not at the top level of Line —
      // `valueLine.TaxCodeRef` was always undefined, so every line's taxRate silently defaulted to 0. Mirror the same
      // detail-first lookup already used correctly by taxCodeSourceId below. Note this still yields a QuickBooks tax-code
      // ID (e.g. "11"), never a real percentage — transactions.module.ts must not trust it as one for QuickBooks imports.
      taxRate: value(object(detail.TaxCodeRef ?? valueLine.TaxCodeRef).value ?? 0),
      itemCode: value(item.name ?? item.value),
      itemSourceId: value(item.value),
      accountNo: value(account.name ?? account.value),
      accountSourceId: value(account.value),
      classSourceId: value(object(detail.ClassRef).value),
      taxCodeSourceId: value(object(detail.TaxCodeRef ?? valueLine.TaxCodeRef).value),
      debit: value(detail.PostingType === 'Debit' ? valueLine.Amount ?? 0 : valueLine.Debit ?? 0),
      credit: value(detail.PostingType === 'Credit' ? valueLine.Amount ?? 0 : valueLine.Credit ?? 0),
      // JournalEntryLineDetail.TaxAmount is an explicit source figure (never inferred): QuickBooks records a taxable JE
      // line's Amount net of tax, with the tax portion carried separately here rather than as its own Line entry — the
      // matching settlement line (e.g. the AP/bank side) is already tax-inclusive. Never extracted before this field
      // existed, which is exactly why so many journal entries' debit and credit sides fell short of balancing by their
      // tax amount. TaxApplicableOn ('Purchase'/'Sale') decides which VAT account the missing line belongs to.
      taxAmount: value(Number(detail.TaxAmount ?? 0)),
      taxApplicableOn: value(detail.TaxApplicableOn ?? ''),
      // A JournalEntryLineDetail line can name the vendor/customer it belongs to (JE 1878/2495: `Entity: {Type:'Vendor',
      // EntityRef:{value:'500'}}`) — this is the only place a JE's vendor identity survives; needed to represent a JE's
      // Accounts-Payable line as a vendor-visible open item without ever posting it to the ledger a second time.
      entityType: value(object(detail.Entity).Type ?? ''),
      entitySourceId: value(object(object(detail.Entity).EntityRef).value ?? ''),
    }
  })
  // Sum(debit) must equal sum(credit) once the tax portion is included on whichever side originally carried it —
  // this is what transactions.module.ts actually posts (see the journal line-building loop), so the header total must
  // match, not the pre-tax sum that silently made every affected JE look short.
  const journalTotal = resourceKey === 'journal-entries'
    ? lines.reduce((sum,line)=>sum+Number(line.debit||0)+(Number(line.debit||0)>0?Number(line.taxAmount||0):0),0)
    : 0
  // QuickBooks Journal Entries report TotalAmt as a literal 0 (it has no real
  // meaning for this entity), so `row.TotalAmt ?? journalTotal` never reached
  // journalTotal — 0 is not nullish. This silently made every journal entry
  // look zero-value to requiresLedgerFor()'s exemption, regardless of its
  // actual debit/credit lines, so postQuickBooksJournal never ran.
  const total = resourceKey === 'journal-entries' ? value(journalTotal) : value(row.TotalAmt ?? row.Amount ?? journalTotal)
  const transactionTax = value(object(row.TxnTaxDetail).TotalTax ?? 0)
  const paymentKind = resourceKey === 'customer-payments' ? 'CUSTOMER' : resourceKey === 'vendor-payments' ? 'VENDOR' : null
  const paymentRelationships = paymentKind ? extractQuickBooksPaymentRelationships(row,paymentKind) : null
  return {
    transactionNo: value(row.DocNumber) || `QB-${value(row.Id)}`,
    sourceId: value(row.Id),
    date: value(row.TxnDate ?? row.TxnDateTime),
    dueDate: value(row.DueDate ?? row.TxnDate),
    expiryDate: value(row.ExpirationDate),
    expectedDate: value(row.ExpectedDate),
    customerName: value(customer.name ?? customer.value ?? entity.name ?? entity.value),
    customerSourceId: value(customer.value ?? entity.value),
    vendorName: value(vendor.name ?? vendor.value),
    vendorSourceId: value(vendor.value),
    amount: total,
    subtotal: value(row.SubTotal ?? (Number(total) - Number(transactionTax))),
    taxAmount: transactionTax,
    total,
    status: nativeTransactionStatus(resourceKey,row),
    currency: value(object(row.CurrencyRef).value ?? 'SAR'),
    exchangeRate: value(row.ExchangeRate ?? 1),
    homeTotal: value(row.HomeTotalAmt ?? (Number(total) * Number(row.ExchangeRate ?? 1))),
    reference: value(row.PrivateNote ?? row.PaymentRefNum ?? row.DocNumber),
    relatedSourceId: value(linked.TxnId),
    allocations: paymentRelationships ? JSON.stringify(paymentRelationships.allocations) : '[]',
    unappliedAmount: value(paymentRelationships?.unappliedAmount ?? 0),
    relationshipIssues: paymentRelationships ? JSON.stringify(paymentRelationships.issues) : '[]',
    description: value(row.PrivateNote ?? row.CustomerMemo),
    category: resourceKey === 'expenses' ? 'Other' : '',
    paymentMethod: value(object(row.PaymentMethodRef).name ?? 'Cash'),
    paymentMethodSourceId: value(object(row.PaymentMethodRef).value),
    // Customer payments/deposits/sales receipts carry DepositToAccountRef. Vendor payments carry no DepositToAccountRef at
    // all — their settlement account is CheckPayment.BankAccountRef (or CreditCardPayment.CCAccountRef); this was never
    // extracted, so every vendor payment posted through the unordered accounts.bank fallback instead of its real account.
    depositAccountSourceId: value(object(row.DepositToAccountRef).value
      || object(object(row.CheckPayment).BankAccountRef).value
      || object(object(row.CreditCardPayment).CCAccountRef).value),
    apAccountSourceId: value(object(row.APAccountRef).value),
    // Purchase (Expense) header AccountRef names the paying/settlement account; only meaningful for the expenses module.
    settlementAccountSourceId: resourceKey === 'expenses' ? value(object(row.AccountRef).value) : '',
    lines: JSON.stringify(lines),
  }
}

function nativeTransactionStatus(resourceKey:string,row:JsonRecord) {
  const balance = Number(row.Balance ?? row.TotalAmt ?? row.Amount ?? 0)
  const total = Number(row.TotalAmt ?? row.Amount ?? 0)
  if (resourceKey === 'invoices') return balance <= 0 ? 'PAID' : balance < total ? 'PARTIAL' : 'SENT'
  if (resourceKey === 'bills') return balance <= 0 ? 'PAID' : balance < total ? 'PARTIAL' : 'RECEIVED'
  if (resourceKey === 'expenses') return 'APPROVED'
  if (resourceKey === 'journal-entries') return 'DRAFT'
  if (resourceKey === 'sales-receipts') return 'POSTED'
  if (resourceKey === 'purchase-orders') return value(row.POStatus ?? row.Status ?? 'OPEN').toUpperCase()
  if (resourceKey === 'vendor-credits') return balance <= 0 ? 'CLOSED' : balance < total ? 'PARTIAL' : 'OPEN'
  if (resourceKey === 'estimates') return value(row.TxnStatus ?? row.Status ?? 'OPEN').toUpperCase()
  return value(row.TxnStatus ?? row.Status ?? 'POSTED').toUpperCase()
}
