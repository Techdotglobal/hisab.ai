import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkDocumentArithmetic, ledgerBalance, type ArithmeticCheck } from './trace-math'

export type TraceDocType = 'invoice' | 'bill' | 'expense'

const CONFIG = {
  invoice: { table: 'invoices', lineTable: 'invoice_lines', fk: 'invoice_id', numberCol: 'invoice_no', sourceType: 'INVOICE', payFk: 'invoice_id' },
  bill: { table: 'bills', lineTable: 'bill_lines', fk: 'bill_id', numberCol: 'bill_no', sourceType: 'BILL', payFk: 'bill_id' },
  expense: { table: 'expenses', lineTable: 'expense_lines', fk: 'expense_id', numberCol: 'expense_no', sourceType: 'EXPENSE', payFk: null },
} as const

export interface DocumentTrace {
  document: { type: TraceDocType; id: string; number: string; status: string; date: string | null; subtotal: number | null; tax: number | null; total: number | null; paid: number | null; balance: number | null }
  lines: Array<{ description: string | null; quantity: number | null; unitPrice: number | null; taxRate: number; amount: number; account: string | null; department: string | null }>
  arithmetic: ArithmeticCheck
  /** null = caller may not read ledger detail */
  ledger: null | {
    posted: boolean
    entries: Array<{ id: string; date: string; account: string; debit: number; credit: number; department: string | null; journalNo: string | null; journalId: string | null }>
    balance: { debit: number; credit: number; balanced: boolean }
    journals: Array<{ id: string; entryNo: string; status: string; reversalOf: string | null; reversedBy: string | null }>
  }
  payments: Array<{ id: string; paymentNo: string; date: string | null; amount: number; method: string | null }>
  /** null = caller may not read the audit log */
  history: null | Array<{ id: string; action: string; at: string; actor: string | null; reason: string | null }>
  notes: string[]
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export async function buildDocumentTrace(input: {
  companyId: string
  type: TraceDocType
  id: string
  includeLedger: boolean
  includeHistory: boolean
}): Promise<DocumentTrace | null> {
  const cfg = CONFIG[input.type]
  const db = createAdminClient()
  const { data: doc, error } = await db.from(cfg.table).select('*').eq('company_id', input.companyId).eq('id', input.id).maybeSingle()
  if (error) throw error
  if (!doc) return null

  const [{ data: lineRows }, { data: ledgerRows }, payments] = await Promise.all([
    db.from(cfg.lineTable).select('*').eq('company_id', input.companyId).eq(cfg.fk, input.id),
    input.includeLedger
      ? db.from('ledger_entries')
          .select('id, entry_date, account_id, debit, credit, cost_center_id, journal_entry_id, account:chart_of_accounts!ledger_entries_account_id_fkey(account_no, name)')
          .eq('company_id', input.companyId).eq('source_type', cfg.sourceType).eq('source_id', input.id).order('posting_sequence', { ascending: true })
      : Promise.resolve({ data: null }),
    cfg.payFk
      ? db.from('payments').select('id, payment_no, date, amount, method').eq('company_id', input.companyId).eq(cfg.payFk, input.id).is('deleted_at', null)
      : Promise.resolve({ data: [] }),
  ])

  const accountIds = [...new Set((lineRows ?? []).map((l) => l.account_id as string | null).filter((i): i is string => Boolean(i)))]
  const ccIds = [...new Set([...(lineRows ?? []).map((l) => l.cost_center_id as string | null), ...(ledgerRows ?? []).map((l) => l.cost_center_id as string | null)].filter((i): i is string => Boolean(i)))]
  const [accts, ccs] = await Promise.all([
    accountIds.length ? db.from('chart_of_accounts').select('id, account_no, name').eq('company_id', input.companyId).in('id', accountIds) : Promise.resolve({ data: [] }),
    ccIds.length ? db.from('cost_centers').select('id, code, name').eq('company_id', input.companyId).in('id', ccIds) : Promise.resolve({ data: [] }),
  ])
  const acctName = new Map((accts.data ?? []).map((a) => [String(a.id), `${a.account_no} ${a.name}`]))
  const ccName = new Map((ccs.data ?? []).map((c) => [String(c.id), `${c.code} ${c.name}`]))

  const lines = (lineRows ?? []).map((l) => ({
    description: (l.description as string | null) ?? null,
    quantity: num(l.quantity),
    unitPrice: num(l.unit_price),
    taxRate: Number(l.tax_rate ?? 0),
    amount: Number(l.amount ?? 0),
    account: l.account_id ? acctName.get(String(l.account_id)) ?? null : null,
    department: l.cost_center_id ? ccName.get(String(l.cost_center_id)) ?? null : null,
  }))

  const subtotal = num(doc.subtotal)
  const tax = num(doc.tax_amount)
  const total = num(doc.total)
  const notes: string[] = []
  const arithmetic = checkDocumentArithmetic(lines, { subtotal: subtotal ?? (input.type === 'expense' && total !== null && tax !== null ? total - tax : null), taxAmount: tax, total })
  if (!lines.length) notes.push('This document has no saved line items.')

  let ledger: DocumentTrace['ledger'] = null
  if (input.includeLedger) {
    const entries = (ledgerRows ?? []).map((e) => {
      const a = e.account as unknown as { account_no: string; name: string } | null
      return {
        id: String(e.id), date: String(e.entry_date).slice(0, 10), account: a ? `${a.account_no} ${a.name}` : String(e.account_id),
        debit: Number(e.debit ?? 0), credit: Number(e.credit ?? 0),
        department: e.cost_center_id ? ccName.get(String(e.cost_center_id)) ?? null : null,
        journalId: (e.journal_entry_id as string | null) ?? null, journalNo: null as string | null,
      }
    })
    const jids = [...new Set(entries.map((e) => e.journalId).filter((i): i is string => Boolean(i)))]
    const journals: NonNullable<DocumentTrace['ledger']>['journals'] = []
    if (jids.length) {
      const { data } = await db.from('journal_entries').select('id, entry_no, status, source_journal_id, reversed_by_journal_id').eq('company_id', input.companyId).in('id', jids)
      for (const j of data ?? []) journals.push({ id: String(j.id), entryNo: String(j.entry_no), status: String(j.status), reversalOf: (j.source_journal_id as string | null) ?? null, reversedBy: (j.reversed_by_journal_id as string | null) ?? null })
      const no = new Map(journals.map((j) => [j.id, j.entryNo]))
      for (const e of entries) e.journalNo = e.journalId ? no.get(e.journalId) ?? null : null
    }
    ledger = { posted: entries.length > 0, entries, balance: ledgerBalance(entries), journals }
    if (!entries.length) notes.push('No ledger lines exist for this document: it is not posted, so it does not affect any financial report yet.')
    else if (!ledger.balance.balanced) notes.push('The ledger lines for this document do not balance — investigate before relying on reports.')
    if (journals.some((j) => j.reversedBy)) notes.push('A journal for this document has been reversed; the reversal is a separate posted entry that offsets the original.')
  }

  let history: DocumentTrace['history'] = null
  if (input.includeHistory) {
    const entityIds = [input.id, ...(ledger?.journals.map((j) => j.id) ?? [])]
    const { data } = await db.from('audit_logs').select('id, action, created_at, user_id, reason')
      .eq('company_id', input.companyId).in('entity_id', entityIds).order('created_at', { ascending: false }).limit(100)
    const uids = [...new Set((data ?? []).map((h) => h.user_id as string | null).filter((i): i is string => Boolean(i)))]
    const names = new Map<string, string>()
    if (uids.length) {
      const { data: profs } = await db.from('profiles').select('id, full_name').in('id', uids)
      for (const p of profs ?? []) names.set(String(p.id), String(p.full_name ?? ''))
    }
    history = (data ?? []).map((h) => ({ id: String(h.id), action: String(h.action), at: String(h.created_at), actor: h.user_id ? names.get(String(h.user_id)) ?? null : null, reason: (h.reason as string | null) ?? null }))
  }

  return {
    document: {
      type: input.type, id: input.id, number: String(doc[cfg.numberCol]), status: String(doc.status),
      date: doc.date ? String(doc.date).slice(0, 10) : null, subtotal, tax, total,
      paid: num(doc.amount_paid), balance: num(doc.balance),
    },
    lines,
    arithmetic,
    ledger,
    payments: (payments.data ?? []).map((p) => ({ id: String(p.id), paymentNo: String(p.payment_no), date: p.date ? String(p.date).slice(0, 10) : null, amount: Number(p.amount ?? 0), method: (p.method as string | null) ?? null })),
    history,
    notes,
  }
}
