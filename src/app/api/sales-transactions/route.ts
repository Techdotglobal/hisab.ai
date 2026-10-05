import { requireAuth } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import { fetchAllRows } from '@/lib/db/repository-utils'

type Row = Record<string, unknown>

export async function GET() {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const client = createAdminClient()
    const [invoiceResult, paymentResult, estimateResult, receiptResult] = await Promise.all([
      fetchAllRows(() => client.from('invoices').select('id,invoice_no,invoice_type,customer_id,date,due_date,total,balance,status,notes,currency,reference,customers(name)').eq('company_id', companyId).is('deleted_at', null).order('date', { ascending: false }).order('id', { ascending: true })),
      fetchAllRows(() => client.from('payments').select('id,payment_no,invoice_id,date,amount,method,reference,notes,currency').eq('company_id', companyId).is('deleted_at', null).order('date', { ascending: false }).order('id', { ascending: true })),
      fetchAllRows(() => client.from('estimates').select('id,estimate_no,customer_id,date,expiry_date,total,status,notes,currency,customers(name)').eq('company_id', companyId).is('deleted_at', null).order('date', { ascending: false }).order('id', { ascending: true })),
      fetchAllRows(() => client.from('sales_receipts').select('id,receipt_no,customer_id,date,total,notes,currency,payment_method,customers(name)').eq('company_id', companyId).is('deleted_at', null).order('date', { ascending: false }).order('id', { ascending: true })),
    ])
    for (const result of [invoiceResult, paymentResult, estimateResult, receiptResult]) if (result.error) throw result.error

    const invoices = (invoiceResult.data ?? []) as Row[]
    const invoiceById = new Map(invoices.map((row) => [String(row.id), row]))
    const customerName = (row: Row) => String(((row.customers as { name?: string } | null)?.name) ?? '—')
    const rows = [
      ...invoices.map((row) => ({
        id: String(row.id), source: 'invoice', type: String(row.invoice_type) === 'CREDIT_NOTE' ? 'Credit Note' : 'Invoice', number: String(row.invoice_no), customerId: String(row.customer_id), customer: customerName(row), date: row.date, dueDate: row.due_date, memo: row.notes ?? '', reference: row.reference ?? '', amount: Number(row.total ?? 0), balance: Number(row.balance ?? 0), status: String(row.status), currency: String(row.currency ?? 'SAR'),
      })),
      ...(paymentResult.data ?? []).map((row: Row) => { const invoice = invoiceById.get(String(row.invoice_id)); return { id: String(row.id), source: 'payment', type: 'Payment', number: String(row.payment_no), customerId: invoice ? String(invoice.customer_id) : null, customer: invoice ? customerName(invoice) : '—', date: row.date, dueDate: null, memo: row.notes ?? '', reference: row.reference ?? '', amount: Number(row.amount ?? 0), balance: 0, status: 'UNAPPLIED', currency: String(row.currency ?? 'SAR') } }),
      ...(estimateResult.data ?? []).map((row: Row) => ({ id: String(row.id), source: 'estimate', type: 'Estimate', number: String(row.estimate_no), customerId: String(row.customer_id), customer: customerName(row), date: row.date, dueDate: row.expiry_date, memo: row.notes ?? '', reference: '', amount: Number(row.total ?? 0), balance: 0, status: String(row.status), currency: String(row.currency ?? 'SAR') })),
      ...(receiptResult.data ?? []).map((row: Row) => ({ id: String(row.id), source: 'sales-receipt', type: 'Sales Receipt', number: String(row.receipt_no), customerId: row.customer_id ? String(row.customer_id) : null, customer: customerName(row), date: row.date, dueDate: null, memo: row.notes ?? '', reference: String(row.payment_method ?? ''), amount: Number(row.total ?? 0), balance: 0, status: 'PAID', currency: String(row.currency ?? 'SAR') })),
    ].sort((a, b) => new Date(String(b.date)).getTime() - new Date(String(a.date)).getTime())
    return Response.json({ items: rows })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') return Response.json({ error: 'Unauthorized' }, { status: 401 })
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
