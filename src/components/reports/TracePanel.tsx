'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Lock } from 'lucide-react'
import { readApiError } from '@/lib/api-client'

interface Trace {
  document: { number: string; status: string; subtotal: number | null; tax: number | null; total: number | null; paid: number | null; balance: number | null }
  lines: Array<{ description: string | null; quantity: number | null; unitPrice: number | null; taxRate: number; amount: number; account: string | null; department: string | null }>
  arithmetic: { lineSubtotal: number; expectedTax: number; checks: Array<{ label: string; stored: number; computed: number; ok: boolean }>; ok: boolean }
  ledger: null | {
    posted: boolean
    entries: Array<{ id: string; date: string; account: string; debit: number; credit: number; department: string | null; journalNo: string | null }>
    balance: { debit: number; credit: number; balanced: boolean }
    journals: Array<{ id: string; entryNo: string; status: string; reversedBy: string | null }>
  }
  payments: Array<{ id: string; paymentNo: string; date: string | null; amount: number; method: string | null }>
  history: null | Array<{ id: string; action: string; at: string; actor: string | null; reason: string | null }>
  notes: string[]
}

const f = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

/** Source document → lines → journal entries & GL lines → payments → audit history. */
export function TracePanel({ type, id }: { type: 'invoice' | 'bill' | 'expense'; id: string }) {
  const [state, setState] = useState<{ id: string; trace?: Trace; error?: string }>({ id: '' })
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await fetch(`/api/trace/${type}/${id}`)
      if (cancelled) return
      if (res.ok) setState({ id, trace: await res.json() })
      else setState({ id, error: res.status === 403 ? 'You do not have permission to view the accounting trail.' : await readApiError(res) })
    })()
    return () => { cancelled = true }
  }, [type, id])

  const cur = state.id === id ? state : null
  if (!cur) return <div className="skeleton h-24 rounded-lg" />
  if (cur.error) return <p className="text-sm text-red-600">{cur.error}</p>
  const t = cur.trace!

  return (
    <div className="space-y-4 text-xs">
      <section>
        <h4 className="mb-1 font-semibold text-slate-800">Arithmetic check</h4>
        <ul className="space-y-1">
          {t.arithmetic.checks.map((c) => (
            <li key={c.label} className={c.ok ? 'text-emerald-700' : 'text-red-700'}>
              {c.ok ? <CheckCircle2 size={12} className="mr-1 inline" /> : <AlertTriangle size={12} className="mr-1 inline" />}
              {c.label}: saved {f(c.stored)}, recomputed {f(c.computed)}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="mb-1 font-semibold text-slate-800">Lines</h4>
        <table className="w-full">
          <thead className="text-[10px] uppercase text-slate-400"><tr><th className="text-left">Description</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">Tax %</th><th className="text-right">Amount</th><th className="pl-3 text-left">GL account</th><th className="text-left">Department</th></tr></thead>
          <tbody>{t.lines.map((l, i) => (
            <tr key={i} className="border-t border-slate-100">
              <td>{l.description ?? '—'}</td><td className="text-right">{l.quantity ?? '—'}</td><td className="text-right">{f(l.unitPrice)}</td><td className="text-right">{l.taxRate}</td><td className="text-right">{f(l.amount)}</td>
              <td className="pl-3">{l.account ?? <span className="text-slate-400">Not assigned</span>}</td><td>{l.department ?? <span className="text-slate-400">Not assigned</span>}</td>
            </tr>))}</tbody>
        </table>
      </section>

      {t.ledger ? (
        <section>
          <h4 className="mb-1 font-semibold text-slate-800">Journal entries and GL lines</h4>
          {t.ledger.entries.length === 0 ? <p className="text-slate-500">Not posted — no GL lines yet.</p> : (
            <>
              <p className="mb-1 text-slate-500">
                {t.ledger.journals.map((j) => `${j.entryNo} (${j.status}${j.reversedBy ? ', reversed' : ''})`).join(', ') || 'No journal entry linked'}
              </p>
              <table className="w-full">
                <thead className="text-[10px] uppercase text-slate-400"><tr><th className="text-left">Date</th><th className="text-left">Account</th><th className="text-left">Department</th><th className="text-right">Debit</th><th className="text-right">Credit</th></tr></thead>
                <tbody>{t.ledger.entries.map((e) => (
                  <tr key={e.id} className="border-t border-slate-100"><td>{e.date}</td><td>{e.account}</td><td>{e.department ?? <span className="text-slate-400">Not assigned</span>}</td><td className="text-right">{e.debit ? f(e.debit) : ''}</td><td className="text-right">{e.credit ? f(e.credit) : ''}</td></tr>
                ))}</tbody>
                <tfoot><tr className="border-t font-semibold"><td colSpan={3}>Totals {t.ledger.balance.balanced ? '(balanced)' : '(NOT balanced)'}</td><td className="text-right">{f(t.ledger.balance.debit)}</td><td className="text-right">{f(t.ledger.balance.credit)}</td></tr></tfoot>
              </table>
            </>
          )}
        </section>
      ) : <p className="flex items-center gap-1 text-slate-500"><Lock size={12} /> Journal and GL detail needs ledger access.</p>}

      {t.payments.length > 0 && (
        <section>
          <h4 className="mb-1 font-semibold text-slate-800">Payments</h4>
          <ul>{t.payments.map((p) => <li key={p.id}>{p.paymentNo} · {p.date ?? '—'} · {f(p.amount)}{p.method ? ` · ${p.method}` : ''}</li>)}</ul>
        </section>
      )}

      {t.history ? (
        <section>
          <h4 className="mb-1 font-semibold text-slate-800">Audit history</h4>
          {t.history.length === 0 ? <p className="text-slate-500">No audit events recorded.</p> : (
            <ul className="space-y-0.5">{t.history.map((h) => <li key={h.id}>{h.at.slice(0, 16).replace('T', ' ')} · {h.action.replace(/_/g, ' ').toLowerCase()} · {h.actor ?? 'system'}{h.reason ? ` — ${h.reason}` : ''}</li>)}</ul>
          )}
        </section>
      ) : <p className="flex items-center gap-1 text-slate-500"><Lock size={12} /> Audit history needs audit-log access.</p>}

      {t.notes.map((n) => <p key={n} className="rounded bg-amber-50 p-2 text-amber-800">⚠ {n}</p>)}
    </div>
  )
}
