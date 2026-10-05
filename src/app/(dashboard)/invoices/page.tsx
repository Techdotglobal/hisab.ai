'use client'

import { useEffect, useState } from 'react'
import { Plus, RefreshCw, Send, DollarSign, RotateCcw, Eye, Shield, FileDown, FileMinus, FilePlus, ChevronLeft, ChevronRight, Edit2 } from 'lucide-react'
import { formatDate, formatCurrency as formatAmount, cn } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { readApiError } from '@/lib/api-client'
import { BusinessBadge, ZatcaBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select, Textarea } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import {
  DEFAULT_INVOICE_FILTERS,
  INVOICE_FILTERS_STORAGE_KEY,
  InvoiceFilterCard,
  loadStoredInvoiceFilters,
  type InvoiceFilterValues,
} from '@/components/invoices/invoice-filter-card'
import {
  EMPTY_INVOICE_LINE,
  InvoiceCreateForm,
  type InvoiceFormState,
} from '@/components/invoices/invoice-create-form'
import { computeDueDate, toDateInputValue } from '@/lib/invoices/payment-terms'
import { computeDisplayBusinessStatus, formatInvoiceTypeLabel, canEditInvoice, todayDateString, isFutureInvoiceDate } from '@/lib/ui/invoice-status'

interface Customer { id: string; name: string }
interface PaymentMethod { id: string; name: string }
interface Account { id: string; accountNo: string; name: string }
interface InvoiceLine {
  description: string
  quantity: number
  unitPrice: number
  taxRate: number
  accountId?: string
  itemName?: string
  projectService?: string
  className?: string
  projectId?: string
  classId?: string
  locationId?: string
  taxRateId?: string
}
interface Invoice {
  id: string; invoiceNo: string; customer: { name: string }; date: string; dueDate: string
  expiryDate?: string | null
  total: number; balance: number; amountPaid: number; status: string; isRecurring: boolean
  currency?: string
  taxCalculationMethod?: string
  terms?: string | null
  invoiceType?: string; zatcaStatus?: string; referencedInvoiceNo?: string | null
  attachments?: Array<{ id: string; originalFilename: string; mimeType: string; fileSize: number }>
}

interface ZatcaInvoiceStatus {
  invoiceId: string
  invoiceNo: string
  zatcaStatus: string
  requestId: string | null
  globalTransactionId: string | null
  responseCode: string | null
  responseMessage: string | null
  clearanceStatus: string | null
  submittedAt: string | null
  environment: string
  submissionRoute: string | null
  canSubmit: boolean
}

const STATUSES = ['DRAFT', 'SENT', 'PAID', 'PARTIAL', 'OVERDUE']
const EMPTY_LINE: InvoiceLine = {
  description: '',
  quantity: 1,
  unitPrice: 0,
  taxRate: 15,
  accountId: '',
  itemName: '',
  projectService: '',
  className: '',
  projectId: '',
  classId: '',
  locationId: '',
  taxRateId: '',
}

function createEmptyForm(currency: string): InvoiceFormState {
  const date = todayDateString()
  return {
    customerId: '',
    date,
    dueDate: toDateInputValue(computeDueDate(date, 30)),
    expiryDate: '',
    notes: '',
    terms: 'Net 30',
    paymentTermId: '',
    taxCalculationMethod: 'TAX_EXCLUSIVE',
    isRecurring: false,
    currency,
    lines: [{ ...EMPTY_INVOICE_LINE }],
  }
}

export default function InvoicesPage() {
  const formatPrimary = useFormatCurrency()
  const { currency: primaryCurrency, isSaudi } = useCompanyCurrency()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])
  const [appliedFilters, setAppliedFilters] = useState<InvoiceFilterValues>(DEFAULT_INVOICE_FILTERS)
  const [draftFilters, setDraftFilters] = useState<InvoiceFilterValues>(DEFAULT_INVOICE_FILTERS)
  const [filtersReady, setFiltersReady] = useState(false)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null)
  const [formDateError, setFormDateError] = useState<string | null>(null)
  const [pdfLoading, setPdfLoading] = useState<'view' | 'download' | null>(null)
  const [showPayModal, setShowPayModal] = useState(false)
  const [showViewModal, setShowViewModal] = useState(false)
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null)
  const [zatcaStatus, setZatcaStatus] = useState<ZatcaInvoiceStatus | null>(null)
  const [submittingZatca, setSubmittingZatca] = useState(false)
  const [zatcaMsg, setZatcaMsg] = useState<string | null>(null)
  const [zatcaErr, setZatcaErr] = useState<string | null>(null)
  const [qrPreview, setQrPreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAdjustmentModal, setShowAdjustmentModal] = useState(false)
  const [adjustmentType, setAdjustmentType] = useState<'CREDIT_NOTE' | 'DEBIT_NOTE'>('CREDIT_NOTE')
  const [adjustmentSource, setAdjustmentSource] = useState<{ id: string; invoiceNo: string; currency?: string } | null>(null)
  const [adjustmentForm, setAdjustmentForm] = useState({
    date: new Date().toISOString().split('T')[0],
    dueDate: '',
    notes: '',
    lines: [{ ...EMPTY_LINE }],
  })

  const [form, setForm] = useState<InvoiceFormState>(() => createEmptyForm('SAR'))
  const [dueDateManuallyEdited, setDueDateManuallyEdited] = useState(false)
  const [payForm, setPayForm] = useState({
    amount: 0, paymentMethodId: '', reference: '',
    date: new Date().toISOString().split('T')[0]
  })

  const limit = 50

  useEffect(() => {
    const stored = loadStoredInvoiceFilters()
    setAppliedFilters(stored)
    setDraftFilters(stored)
    setFiltersReady(true)
  }, [])

  function patchDraftFilters(patch: Partial<InvoiceFilterValues>) {
    setDraftFilters((current) => ({ ...current, ...patch }))
  }

  function applyFilters() {
    setAppliedFilters(draftFilters)
    setPage(1)
    try {
      localStorage.setItem(INVOICE_FILTERS_STORAGE_KEY, JSON.stringify(draftFilters))
    } catch {
      // Ignore storage failures.
    }
  }

  function resetDraftFilters() {
    setDraftFilters(DEFAULT_INVOICE_FILTERS)
  }

  function clearAllFilters() {
    setDraftFilters(DEFAULT_INVOICE_FILTERS)
    setAppliedFilters(DEFAULT_INVOICE_FILTERS)
    setPage(1)
    try {
      localStorage.removeItem(INVOICE_FILTERS_STORAGE_KEY)
    } catch {
      // Ignore storage failures.
    }
  }

  async function load() {
    setLoading(true)
    const params = new URLSearchParams()
    if (appliedFilters.search) params.set('search', appliedFilters.search)
    if (appliedFilters.statusFilter) params.set('status', appliedFilters.statusFilter)
    if (appliedFilters.zatcaFilter) params.set('zatcaStatus', appliedFilters.zatcaFilter)
    if (appliedFilters.typeFilter) params.set('invoiceType', appliedFilters.typeFilter)
    if (appliedFilters.customerFilter) params.set('customerId', appliedFilters.customerFilter)
    if (appliedFilters.datePreset) params.set('datePreset', appliedFilters.datePreset)
    if (appliedFilters.datePreset === 'custom') {
      if (appliedFilters.dateFrom) params.set('dateFrom', appliedFilters.dateFrom)
      if (appliedFilters.dateTo) params.set('dateTo', appliedFilters.dateTo)
    }
    params.set('sortBy', appliedFilters.sortBy)
    params.set('sortDir', appliedFilters.sortDir)
    params.set('page', String(page))
    params.set('limit', String(limit))
    const [invRes, custRes, accRes, methodRes] = await Promise.all([
      fetch(`/api/invoices?${params}`),
      fetch('/api/customers'),
      fetch('/api/accounts'),
      fetch('/api/product-master/payment-methods'),
    ])
    if (invRes.ok) {
      const payload = await invRes.json()
      setInvoices(payload.items ?? payload)
      setListTotal(payload.total ?? (payload.items?.length ?? 0))
    }
    if (custRes.ok) setCustomers(await custRes.json())
    if (accRes.ok) setAccounts(await accRes.json())
    if (methodRes.ok) {
      const methods = await methodRes.json()
      setPaymentMethods(methods)
      setPayForm(current => current.paymentMethodId || !methods.length ? current : { ...current, paymentMethodId: methods[0].id })
    }
    setLoading(false)
  }

  useEffect(() => {
    if (!filtersReady) return
    load()
  }, [filtersReady, appliedFilters, page])

  function formatInvoiceAmount(invoice: Pick<Invoice, 'total' | 'balance' | 'amountPaid' | 'currency'>, amount: number) {
    return formatAmount(amount, invoice.currency ?? primaryCurrency)
  }

  async function handleSave() {
    if (isFutureInvoiceDate(form.date)) {
      setFormDateError('Invoice date cannot be in the future.')
      return
    }
    setFormDateError(null)
    setSaving(true)
    const url = editingInvoiceId ? `/api/invoices/${editingInvoiceId}` : '/api/invoices'
    const method = editingInvoiceId ? 'PUT' : 'POST'
    const payload = {
      customerId: form.customerId,
      date: form.date,
      dueDate: form.dueDate,
      expiryDate: form.expiryDate || null,
      notes: form.notes,
      terms: form.terms,
      paymentTermId: form.paymentTermId || null,
      taxCalculationMethod: form.taxCalculationMethod,
      isRecurring: form.isRecurring,
      currency: form.currency,
      lines: form.lines.map((line) => ({
        itemName: line.itemName,
        description: line.description,
        projectId: line.projectId || null,
        classId: line.classId || null,
        locationId: line.locationId || null,
        projectService: line.projectService || null,
        className: line.className || null,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxRate: form.taxCalculationMethod === 'OUT_OF_SCOPE' ? 0 : line.taxRate,
        taxRateId: line.taxRateId || null,
        accountId: line.accountId || null,
        inventoryItemId: line.inventoryItemId || null,
      })),
    }
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    })
    if (!res.ok) {
      alert(await readApiError(res))
      setSaving(false)
      return
    }
    const saved = await res.json()
    if (!editingInvoiceId && saved?.id) {
      setEditingInvoiceId(saved.id)
      setSaving(false)
      await load()
      return
    }
    setEditingInvoiceId(null)
    setShowModal(false)
    load()
    setSaving(false)
  }

  async function handlePayment() {
    if (!selectedInvoice) return
    const res = await fetch(`/api/invoices/${selectedInvoice.id}/payment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payForm)
    })
    if (!res.ok) {
      alert(await readApiError(res))
      return
    }
    if (res.ok) { setShowPayModal(false); load() }
  }

  async function handleSend(id: string) {
    await fetch(`/api/invoices/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'SENT' })
    })
    load()
  }

  function openPay(inv: Invoice) {
    setSelectedInvoice(inv)
    setPayForm(f => ({ ...f, amount: inv.balance, paymentMethodId: f.paymentMethodId || paymentMethods[0]?.id || '' }))
    setShowPayModal(true)
  }

  async function openView(inv: Invoice) {
    setZatcaMsg(null)
    setZatcaErr(null)
    setQrPreview(null)
    setShowViewModal(true)
    const [detailRes, statusRes, qrRes] = await Promise.all([
      fetch(`/api/invoices/${inv.id}`),
      isSaudi ? fetch(`/api/zatca/invoices/${inv.id}/status`) : Promise.resolve(null),
      isSaudi ? fetch(`/api/zatca/invoices/${inv.id}/qr`) : Promise.resolve(null),
    ])
    if (detailRes.ok) {
      const full = await detailRes.json()
      setSelectedInvoice({
        ...inv,
        ...full,
        customer: full.customer ?? inv.customer,
      })
    } else {
      setSelectedInvoice(inv)
    }
    if (statusRes?.ok) setZatcaStatus(await statusRes.json())
    else setZatcaStatus(null)
    if (qrRes?.ok) {
      const qr = await qrRes.json()
      setQrPreview(qr.qrDataUrl ?? null)
    }
  }

  function viewPdf(inv: Invoice) {
    setPdfLoading('view')
    const popup = window.open(`/api/invoices/${inv.id}/pdf?disposition=inline`, '_blank')
    if (!popup) {
      alert('Pop-up blocked. Please allow pop-ups to view the PDF.')
    }
    setPdfLoading(null)
  }

  async function downloadPdf(inv: Invoice) {
    setPdfLoading('download')
    try {
      const res = await fetch(`/api/invoices/${inv.id}/pdf?disposition=attachment`)
      if (!res.ok) {
        alert(await readApiError(res))
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${inv.invoiceNo}.pdf`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch {
      alert('Failed to download PDF. Please try again.')
    } finally {
      setPdfLoading(null)
    }
  }

  function resetInvoiceForm() {
    setEditingInvoiceId(null)
    setFormDateError(null)
    setDueDateManuallyEdited(false)
    setForm(createEmptyForm(primaryCurrency))
  }

  function openCreate() {
    resetInvoiceForm()
    setShowModal(true)
  }

  function toDateInputValueLocal(value: string | Date | undefined | null): string {
    if (!value) return ''
    const raw = typeof value === 'string' ? value : value.toISOString()
    return raw.split('T')[0]
  }

  async function openEdit(inv: Invoice) {
    const res = await fetch(`/api/invoices/${inv.id}`)
    if (!res.ok) {
      alert(await readApiError(res))
      return
    }
    const full = await res.json()
    const zatca = full.zatcaStatus ?? inv.zatcaStatus
    if (!canEditInvoice(zatca)) {
      alert('This invoice cannot be edited after ZATCA submission.')
      return
    }
    setForm({
      customerId: full.customerId ?? '',
      date: toDateInputValueLocal(full.date),
      dueDate: toDateInputValueLocal(full.dueDate),
      expiryDate: toDateInputValueLocal(full.expiryDate),
      currency: full.currency ?? primaryCurrency,
      notes: full.notes ?? '',
      terms: full.terms ?? 'Net 30',
      paymentTermId: full.paymentTermId ?? '',
      taxCalculationMethod: full.taxCalculationMethod ?? 'TAX_EXCLUSIVE',
      isRecurring: full.isRecurring ?? false,
      lines: (full.lines ?? []).length > 0
        ? full.lines.map((line: InvoiceLine & { taxRateId?: string; itemName?: string; projectService?: string; className?: string; projectId?: string; classId?: string; locationId?: string }) => ({
            itemName: line.itemName ?? '',
            description: line.description ?? '',
            projectId: line.projectId ?? '',
            classId: line.classId ?? '',
            locationId: line.locationId ?? '',
            projectService: line.projectService ?? '',
            className: line.className ?? '',
            quantity: line.quantity ?? 1,
            unitPrice: line.unitPrice ?? 0,
            taxRate: line.taxRate ?? 15,
            taxRateId: line.taxRateId ?? '',
            accountId: line.accountId ?? '',
          }))
        : [{ ...EMPTY_INVOICE_LINE }],
    })
    setDueDateManuallyEdited(true)
    setEditingInvoiceId(inv.id)
    setFormDateError(null)
    setShowViewModal(false)
    setShowModal(true)
  }

  function openArtifact(type: 'xml' | 'signed-xml' | 'qr') {
    if (!selectedInvoice) return
    const base = `/api/zatca/invoices/${selectedInvoice.id}`
    const url = type === 'xml' ? `${base}/xml` : type === 'signed-xml' ? `${base}/signed-xml` : `${base}/qr`
    window.open(url, '_blank')
  }

  async function handleZatcaSubmit() {
    if (!selectedInvoice) return
    setSubmittingZatca(true)
    setZatcaMsg(null)
    setZatcaErr(null)
    const res = await fetch(`/api/zatca/invoices/${selectedInvoice.id}/submit`, { method: 'POST' })
    const data = await res.json()
    if (res.ok) {
      setZatcaMsg(`Submitted via ${data.route} API — status: ${data.zatcaStatus}`)
      const statusRes = await fetch(`/api/zatca/invoices/${selectedInvoice.id}/status`)
      if (statusRes.ok) setZatcaStatus(await statusRes.json())
      load()
    } else {
      setZatcaErr(data.error || 'Submission failed')
    }
    setSubmittingZatca(false)
  }

  function canCreateAdjustment(inv: Invoice | null, status: ZatcaInvoiceStatus | null) {
    if (!inv) return false
    const type = inv.invoiceType ?? 'STANDARD'
    if (type !== 'STANDARD' && type !== 'SIMPLIFIED') return false
    if (isSaudi) {
      if (!status) return false
      return status.zatcaStatus === 'CLEARED' || status.zatcaStatus === 'REPORTED'
    }
    return ['SENT', 'PARTIAL', 'PAID', 'OVERDUE'].includes(computeDisplayBusinessStatus(inv))
  }

  function updateAdjustmentLine(idx: number, field: string, value: string | number) {
    setAdjustmentForm(f => ({
      ...f,
      lines: f.lines.map((l, i) => i === idx ? { ...l, [field]: value } : l),
    }))
  }

  async function openAdjustment(type: 'CREDIT_NOTE' | 'DEBIT_NOTE', inv: Invoice) {
    setAdjustmentType(type)
    setAdjustmentSource({ id: inv.id, invoiceNo: inv.invoiceNo, currency: inv.currency })
    const res = await fetch(`/api/invoices/${inv.id}`)
    if (!res.ok) {
      alert(await readApiError(res))
      return
    }
    const full = await res.json()
    const today = new Date().toISOString().split('T')[0]
    setAdjustmentForm({
      date: today,
      dueDate: today,
      notes: type === 'CREDIT_NOTE' ? `Credit note for ${inv.invoiceNo}` : `Debit note for ${inv.invoiceNo}`,
      lines: (full.lines ?? []).map((line: InvoiceLine) => ({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxRate: line.taxRate,
        accountId: line.accountId ?? '',
      })),
    })
    setShowAdjustmentModal(true)
  }

  async function handleSaveAdjustment() {
    if (!adjustmentSource) return
    setSaving(true)
    const endpoint = adjustmentType === 'CREDIT_NOTE' ? 'credit-note' : 'debit-note'
    const res = await fetch(`/api/invoices/${adjustmentSource.id}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adjustmentForm),
    })
    if (!res.ok) {
      alert(await readApiError(res))
      setSaving(false)
      return
    }
    const created = await res.json()
    setShowAdjustmentModal(false)
    setSaving(false)
    await load()
    const detailRes = await fetch(`/api/invoices/${created.id}`)
    if (detailRes.ok) {
      const full = await detailRes.json()
      await openView({
        ...full,
        customer: full.customer ?? { name: '' },
      })
    }
  }

  const adjustmentSubtotal = adjustmentForm.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
  const adjustmentTax = adjustmentForm.lines.reduce((s, l) => s + l.quantity * l.unitPrice * (l.taxRate / 100), 0)
  const adjustmentTotal = adjustmentSubtotal + adjustmentTax

  const totalPages = Math.max(1, Math.ceil(listTotal / limit))

  const stats = {
    total: listTotal,
    paid: invoices.filter(i => computeDisplayBusinessStatus(i) === 'PAID').length,
    outstanding: invoices.filter(i => ['SENT', 'PARTIAL', 'OVERDUE'].includes(computeDisplayBusinessStatus(i)) && i.balance > 0).length,
    totalValue: invoices.reduce((s, i) => s + i.total, 0),
  }

  const adjustmentCurrency = adjustmentSource?.currency ?? primaryCurrency
  const formatAdjustmentAmount = (amount: number) => formatAmount(amount, adjustmentCurrency)

  const invoiceTableHeaders = isSaudi
    ? ['Invoice #', 'Customer', 'Date', 'Due Date', 'Total', 'Paid', 'Balance', 'Business', 'ZATCA', '']
    : ['Invoice #', 'Customer', 'Date', 'Due Date', 'Total', 'Paid', 'Balance', 'Business', '']

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-4">
      <PageHeader
        title="Invoices"
        subtitle={`${stats.total} invoices · ${formatPrimary(stats.totalValue)} total`}
        breadcrumb={[{ label: 'Income' }, { label: 'Invoices' }]}
        action={
          <Button onClick={openCreate}>
            <Plus size={15} /> New Invoice
          </Button>
        }
      />

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Invoices', value: stats.total, color: 'text-slate-700' },
          { label: 'Paid', value: stats.paid, color: 'text-emerald-600' },
          { label: 'Outstanding', value: stats.outstanding, color: 'text-amber-600' },
          { label: 'Total Value', value: formatPrimary(stats.totalValue), color: 'text-indigo-600' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-200 px-4 py-3">
            <p className="text-xs text-slate-400 font-medium">{s.label}</p>
            <p className={cn('text-lg font-bold mt-0.5', s.color)}>{s.value}</p>
          </div>
        ))}
      </div>

      <InvoiceFilterCard
        draft={draftFilters}
        applied={appliedFilters}
        customers={customers}
        onChange={patchDraftFilters}
        onApply={applyFilters}
        onResetDraft={resetDraftFilters}
        onClearAll={clearAllFilters}
      />

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-end border-b border-slate-100 px-4 py-2">
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
            aria-label="Refresh invoices"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {invoiceTableHeaders.map((h, i) => (
                  <th key={i} className={cn(
                    'px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap',
                    ['Total', 'Paid', 'Balance'].includes(h) ? 'text-right' : 'text-left',
                    h === '' && 'w-24'
                  )}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: invoiceTableHeaders.length }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>
                    ))}
                  </tr>
                ))
              ) : invoices.length === 0 ? (
                <tr><td colSpan={invoiceTableHeaders.length} className="px-4 py-16 text-center text-slate-400 text-sm">No invoices found</td></tr>
              ) : invoices.map(inv => (
                <tr key={inv.id} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs font-semibold text-indigo-600">{inv.invoiceNo}</span>
                    {inv.invoiceType && inv.invoiceType !== 'STANDARD' && (
                      <span className="block text-[10px] font-medium text-slate-500 mt-0.5">{formatInvoiceTypeLabel(inv.invoiceType)}</span>
                    )}
                    {inv.isRecurring && <RotateCcw size={10} className="inline ml-1.5 text-violet-400" />}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-700 font-medium">{inv.customer.name}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(inv.date)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(inv.dueDate)}</td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-slate-900 tabular">{formatInvoiceAmount(inv, inv.total)}</td>
                  <td className="px-4 py-3 text-right text-xs text-emerald-600 font-medium tabular">{formatInvoiceAmount(inv, inv.amountPaid)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={cn('text-xs font-semibold tabular', inv.balance > 0 ? 'text-amber-600' : 'text-slate-300')}>
                      {inv.balance > 0 ? formatInvoiceAmount(inv, inv.balance) : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <BusinessBadge status={computeDisplayBusinessStatus(inv)} />
                  </td>
                  {isSaudi && (
                  <td className="px-4 py-3">
                    <ZatcaBadge status={inv.zatcaStatus ?? 'DRAFT'} />
                  </td>
                  )}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      <button onClick={() => openView(inv)}
                        className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors">
                        <Eye size={10} /> View
                      </button>
                      <button onClick={() => viewPdf(inv)}
                        className="flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 px-2 py-1 rounded-lg transition-colors">
                        <Eye size={10} /> PDF
                      </button>
                      {canEditInvoice(inv.zatcaStatus) && (
                        <button onClick={() => openEdit(inv)}
                          className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-100 px-2 py-1 rounded-lg transition-colors">
                          <Edit2 size={10} /> Edit
                        </button>
                      )}
                      {inv.status === 'DRAFT' && (
                        <button onClick={() => handleSend(inv.id)}
                          className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-800 hover:bg-blue-50 px-2 py-1 rounded-lg transition-colors">
                          <Send size={10} /> Send
                        </button>
                      )}
                      {inv.balance > 0 && inv.status !== 'DRAFT' && (
                        <button onClick={() => openPay(inv)}
                          className="flex items-center gap-1 text-[11px] font-semibold text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 px-2 py-1 rounded-lg transition-colors">
                          <DollarSign size={10} /> Pay
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-sm text-slate-500">
          <span>Page {page} of {totalPages} · {listTotal} invoices</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={14} /></Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight size={14} /></Button>
          </div>
        </div>
      </div>
      <Modal
        open={showModal}
        onClose={() => { setShowModal(false); resetInvoiceForm() }}
        title={editingInvoiceId ? 'Edit Invoice' : 'New Invoice'}
        subtitle={editingInvoiceId
          ? (isSaudi ? 'Update invoice details before ZATCA submission' : 'Update invoice details')
          : 'Create a new customer invoice'}
        size="3xl"
        footer={
          <>
            <Button variant="outline" onClick={() => { setShowModal(false); resetInvoiceForm() }}>Cancel</Button>
            <Button onClick={handleSave} loading={saving}>
              {editingInvoiceId ? 'Update Invoice' : 'Save Draft'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <InvoiceCreateForm
            form={form}
            setForm={setForm}
            customers={customers}
            accounts={accounts}
            primaryCurrency={primaryCurrency}
            formDateError={formDateError}
            setFormDateError={setFormDateError}
            invoiceId={editingInvoiceId}
            dueDateManuallyEdited={dueDateManuallyEdited}
            setDueDateManuallyEdited={setDueDateManuallyEdited}
          />
        </div>
      </Modal>

      {/* Invoice View + ZATCA Modal */}
      <Modal
        open={showViewModal}
        onClose={() => setShowViewModal(false)}
        title={selectedInvoice ? selectedInvoice.invoiceNo : 'Invoice'}
        subtitle={selectedInvoice ? selectedInvoice.customer.name : ''}
        size="lg"
        footer={
          <div className="w-full flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedInvoice || pdfLoading !== null}
                loading={pdfLoading === 'view'}
                onClick={() => selectedInvoice && viewPdf(selectedInvoice)}
              >
                <Eye size={14} /> View PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedInvoice || pdfLoading !== null}
                loading={pdfLoading === 'download'}
                onClick={() => selectedInvoice && downloadPdf(selectedInvoice)}
              >
                <FileDown size={14} /> Download PDF
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {selectedInvoice && canEditInvoice(zatcaStatus?.zatcaStatus ?? selectedInvoice.zatcaStatus) && (
                <Button variant="outline" size="sm" onClick={() => openEdit(selectedInvoice)}>
                  <Edit2 size={14} /> Edit
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setShowViewModal(false)}>Close</Button>
              {isSaudi && zatcaStatus?.canSubmit && (
                <Button size="sm" onClick={handleZatcaSubmit} loading={submittingZatca}>
                  <Shield size={14} /> Submit to ZATCA
                </Button>
              )}
            </div>
          </div>
        }
      >
        {selectedInvoice && (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2">
              <BusinessBadge status={computeDisplayBusinessStatus(selectedInvoice)} />
              {isSaudi && (
                <ZatcaBadge status={zatcaStatus?.zatcaStatus ?? selectedInvoice.zatcaStatus ?? 'DRAFT'} />
              )}
              <span className="badge bg-slate-50 text-slate-600 border border-slate-200">{formatInvoiceTypeLabel(selectedInvoice.invoiceType)}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-xs text-slate-400">Date</p><p className="font-medium">{formatDate(selectedInvoice.date)}</p></div>
              <div><p className="text-xs text-slate-400">Due</p><p className="font-medium">{formatDate(selectedInvoice.dueDate)}</p></div>
              {selectedInvoice.expiryDate && (
                <div><p className="text-xs text-slate-400">Expiry</p><p className="font-medium">{formatDate(selectedInvoice.expiryDate)}</p></div>
              )}
              <div><p className="text-xs text-slate-400">Terms</p><p className="font-medium">{selectedInvoice.terms || '—'}</p></div>
              <div>
                <p className="text-xs text-slate-400">Tax Method</p>
                <p className="font-medium">
                  {selectedInvoice.taxCalculationMethod === 'TAX_INCLUSIVE'
                    ? 'Tax Inclusive'
                    : selectedInvoice.taxCalculationMethod === 'OUT_OF_SCOPE'
                      ? 'Out of Scope'
                      : 'Tax Exclusive'}
                </p>
              </div>
              <div><p className="text-xs text-slate-400">Type</p><p className="font-medium">{formatInvoiceTypeLabel(selectedInvoice.invoiceType)}</p></div>
              <div><p className="text-xs text-slate-400">Customer</p><p className="font-medium">{selectedInvoice.customer.name}</p></div>
              {selectedInvoice.referencedInvoiceNo && (
                <div><p className="text-xs text-slate-400">References</p><p className="font-medium">{selectedInvoice.referencedInvoiceNo}</p></div>
              )}
              <div><p className="text-xs text-slate-400">Currency</p><p className="font-medium">{selectedInvoice.currency ?? primaryCurrency}</p></div>
              <div><p className="text-xs text-slate-400">Total</p><p className="font-semibold text-indigo-600">{formatInvoiceAmount(selectedInvoice, selectedInvoice.total)}</p></div>
              <div><p className="text-xs text-slate-400">Balance</p><p className="font-medium">{formatInvoiceAmount(selectedInvoice, selectedInvoice.balance)}</p></div>
            </div>

            {selectedInvoice.attachments && selectedInvoice.attachments.length > 0 && (
              <div className="rounded-xl border border-slate-200 p-4 space-y-2">
                <h3 className="font-semibold text-slate-800 text-sm">Attachments</h3>
                <ul className="space-y-1">
                  {selectedInvoice.attachments.map((a) => (
                    <li key={a.id} className="flex items-center justify-between text-sm">
                      <span className="text-slate-700">{a.originalFilename}</span>
                      <a
                        className="text-indigo-600 hover:text-indigo-800 text-xs font-medium"
                        href={`/api/invoices/${selectedInvoice.id}/attachments/${a.id}`}
                      >
                        Download
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {canCreateAdjustment(selectedInvoice, zatcaStatus) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
                <div>
                  <h3 className="font-semibold text-slate-800">Adjustments</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    {isSaudi
                      ? 'Create a ZATCA credit or debit note linked to this invoice via BillingReference.'
                      : 'Create a credit or debit note linked to this invoice.'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => openAdjustment('CREDIT_NOTE', selectedInvoice)}>
                    <FileMinus size={14} /> Create Credit Note
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openAdjustment('DEBIT_NOTE', selectedInvoice)}>
                    <FilePlus size={14} /> Create Debit Note
                  </Button>
                </div>
              </div>
            )}

            {isSaudi && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Shield size={16} className="text-emerald-600" />
                <h3 className="font-semibold text-slate-800">ZATCA E-Invoicing</h3>
              </div>
              {zatcaStatus ? (
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-slate-400">ZATCA Status</p>
                    <ZatcaBadge status={zatcaStatus.zatcaStatus} />
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Environment</p>
                    <p className="font-medium">{zatcaStatus.environment}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Submission Route</p>
                    <p className="font-medium capitalize">{zatcaStatus.submissionRoute ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Last Submission</p>
                    <p className="font-medium">{zatcaStatus.submittedAt ? formatDate(zatcaStatus.submittedAt) : '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Request ID</p>
                    <p className="font-mono text-xs break-all">{zatcaStatus.requestId ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Global Transaction ID</p>
                    <p className="font-mono text-xs break-all">{zatcaStatus.globalTransactionId ?? '—'}</p>
                  </div>
                  {zatcaStatus.responseMessage && (
                    <div className="col-span-2">
                      <p className="text-xs text-slate-400">Response Message</p>
                      <p className="text-sm text-slate-600">{zatcaStatus.responseMessage}</p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-500">Loading ZATCA status...</p>
              )}
              <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
                <Button variant="outline" size="sm" onClick={() => openArtifact('xml')}>View XML</Button>
                <Button variant="outline" size="sm" onClick={() => openArtifact('signed-xml')}>View Signed XML</Button>
                <Button variant="outline" size="sm" onClick={() => openArtifact('qr')}>View QR</Button>
              </div>
              {qrPreview && (
                <div className="pt-2">
                  <p className="text-xs text-slate-400 mb-2">QR Code</p>
                  <img src={qrPreview} alt="ZATCA QR" className="w-32 h-32 border border-slate-200 rounded-lg" />
                </div>
              )}
              {zatcaMsg && <p className="text-sm text-emerald-600">{zatcaMsg}</p>}
              {zatcaErr && <p className="text-sm text-red-600">{zatcaErr}</p>}
            </div>
            )}
          </div>
        )}
      </Modal>

      {/* Credit / Debit Note Modal */}
      <Modal
        open={showAdjustmentModal}
        onClose={() => setShowAdjustmentModal(false)}
        title={adjustmentType === 'CREDIT_NOTE' ? 'Create Credit Note' : 'Create Debit Note'}
        subtitle={adjustmentSource ? `Adjustment for ${adjustmentSource.invoiceNo}` : ''}
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowAdjustmentModal(false)}>Cancel</Button>
            <Button onClick={handleSaveAdjustment} loading={saving}>
              {adjustmentType === 'CREDIT_NOTE' ? 'Save Credit Note' : 'Save Debit Note'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Date" type="date" required value={adjustmentForm.date}
              onChange={e => setAdjustmentForm({ ...adjustmentForm, date: e.target.value })} />
            <Input label="Due Date" type="date" required value={adjustmentForm.dueDate}
              onChange={e => setAdjustmentForm({ ...adjustmentForm, dueDate: e.target.value })} />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Line Items</label>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    {['Description', 'Qty', 'Unit Price', 'Tax %', 'Amount', ''].map((h, i) => (
                      <th key={i} className="px-3 py-2.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wider text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {adjustmentForm.lines.map((line, idx) => (
                    <tr key={idx}>
                      <td className="px-2 py-2">
                        <input value={line.description} onChange={e => updateAdjustmentLine(idx, 'description', e.target.value)}
                          placeholder="Description" className="input-base text-xs py-1.5" />
                      </td>
                      <td className="px-2 py-2 w-20">
                        <input type="number" min="0" step="0.01" value={line.quantity}
                          onChange={e => updateAdjustmentLine(idx, 'quantity', parseFloat(e.target.value) || 0)}
                          className="input-base text-xs py-1.5 text-right" />
                      </td>
                      <td className="px-2 py-2 w-28">
                        <input type="number" min="0" step="0.01" value={line.unitPrice}
                          onChange={e => updateAdjustmentLine(idx, 'unitPrice', parseFloat(e.target.value) || 0)}
                          className="input-base text-xs py-1.5 text-right" />
                      </td>
                      <td className="px-2 py-2 w-20">
                        <input type="number" min="0" max="100" value={line.taxRate}
                          onChange={e => updateAdjustmentLine(idx, 'taxRate', parseFloat(e.target.value) || 0)}
                          className="input-base text-xs py-1.5 text-right" />
                      </td>
                      <td className="px-3 py-2 text-right text-sm font-semibold text-slate-700 tabular whitespace-nowrap">
                        {formatAdjustmentAmount(line.quantity * line.unitPrice * (1 + line.taxRate / 100))}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <button onClick={() => setAdjustmentForm(f => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }))}
                          className="w-6 h-6 rounded-lg bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 flex items-center justify-center transition-colors text-base leading-none">
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="bg-slate-50 border-t border-slate-200 px-4 py-3 flex flex-col items-end gap-1">
                <div className="flex gap-8 text-sm">
                  <span className="text-slate-500">Subtotal:</span>
                  <span className="font-medium text-slate-700 tabular w-28 text-right">{formatAdjustmentAmount(adjustmentSubtotal)}</span>
                </div>
                <div className="flex gap-8 text-sm">
                  <span className="text-slate-500">VAT:</span>
                  <span className="font-medium text-slate-700 tabular w-28 text-right">{formatAdjustmentAmount(adjustmentTax)}</span>
                </div>
                <div className="flex gap-8 text-base font-bold border-t border-slate-200 pt-1 mt-1">
                  <span className="text-slate-800">Total:</span>
                  <span className="text-indigo-600 tabular w-28 text-right">{formatAdjustmentAmount(adjustmentTotal)}</span>
                </div>
              </div>
            </div>
            <button
              onClick={() => setAdjustmentForm(f => ({ ...f, lines: [...f.lines, { ...EMPTY_LINE }] }))}
              className="mt-2 flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
            >
              <Plus size={14} /> Add Line Item
            </button>
          </div>

          <Textarea label="Notes" value={adjustmentForm.notes}
            onChange={e => setAdjustmentForm({ ...adjustmentForm, notes: e.target.value })} rows={2} />
        </div>
      </Modal>

      {/* Payment Modal */}
      <Modal
        open={showPayModal}
        onClose={() => setShowPayModal(false)}
        title="Record Payment"
        subtitle={selectedInvoice ? `${selectedInvoice.invoiceNo} · Balance: ${formatInvoiceAmount(selectedInvoice, selectedInvoice.balance)}` : ''}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowPayModal(false)}>Cancel</Button>
            <Button variant="success" onClick={handlePayment}>
              <DollarSign size={14} /> Record Payment
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Amount" type="number" required value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: parseFloat(e.target.value) })} />
          <Input label="Date" type="date" required value={payForm.date} onChange={e => setPayForm({ ...payForm, date: e.target.value })} />
          <Select label="Payment method" value={payForm.paymentMethodId} onChange={e => setPayForm({ ...payForm, paymentMethodId: e.target.value })}>
            <option value="">Select</option>
            {paymentMethods.map(method => <option key={method.id} value={method.id}>{method.name}</option>)}
          </Select>
          <Input label="Reference" value={payForm.reference} onChange={e => setPayForm({ ...payForm, reference: e.target.value })} placeholder="Transaction ID..." />
        </div>
      </Modal>
    </div>
  )
}
