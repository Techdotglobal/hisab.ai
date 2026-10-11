'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Upload, ArrowLeftRight } from 'lucide-react'
import { formatDate, formatCurrency as formatAmount, cn } from '@/lib/utils'
import { useCompanyCurrency, useFormatCurrency } from '@/hooks/use-company-currency'
import { ALLOWED_CURRENCIES } from '@/lib/currency/constants'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select, Textarea } from '@/components/ui/input'
import { PageHeader, FilterBar } from '@/components/ui/page-header'
import { readApiError } from '@/lib/api-client'
import { ExportMenu } from '@/components/data-tools/export-menu'
import { FilterPanel, inDateRange, type FilterValues } from '@/components/data-tools/filter-panel'
import type { ExportColumn } from '@/lib/export/table-export'

type Tab = 'accounts' | 'transactions' | 'reconciliation' | 'transfers' | 'cheques'

interface BankAccount {
  id: string; name: string; bankName?: string; accountNumber?: string
  currency: string; currentBalance: number; openingBalance: number; accountType: string; isActive: boolean
}
interface BankTransaction {
  id: string; transactionDate: string; description: string; reference?: string
  amount: number; type: string; status: string; bankAccount?: { name: string; currency: string }
}
interface Reconciliation {
  id: string; statementDate: string; statementBalance: number; reconciledBalance: number
  status: string; bankAccount?: { name: string; currency: string }
}
interface Transfer {
  id: string; transferNo: string; fromAccountId: string; toAccountId: string
  date: string; amount: number; reference?: string
}
interface Cheque {
  id: string; chequeNo: string; payee: string; amount: number; issueDate: string
  clearanceDate?: string; status: string; bankAccount?: { name: string }
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'reconciliation', label: 'Reconciliation' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'cheques', label: 'Cheques' },
]

export default function BankingPage() {
  const formatPrimary = useFormatCurrency()
  const { currency: primaryCurrency } = useCompanyCurrency()
  const [tab, setTab] = useState<Tab>('accounts')
  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [transactions, setTransactions] = useState<BankTransaction[]>([])
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [cheques, setCheques] = useState<Cheque[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [txnFilters, setTxnFilters] = useState<FilterValues>({ type: '', status: '', from: '', to: '' })
  const [showAccountModal, setShowAccountModal] = useState(false)
  const [showTxnModal, setShowTxnModal] = useState(false)
  const [showReconModal, setShowReconModal] = useState(false)
  const [showTransferModal, setShowTransferModal] = useState(false)
  const [showChequeModal, setShowChequeModal] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [csvText, setCsvText] = useState('date,description,amount\n2026-01-01,Sample deposit,1000')

  const [accountForm, setAccountForm] = useState({
    name: '', bankName: '', accountNumber: '', currency: 'SAR', openingBalance: 0, accountType: 'BANK',
  })
  const [txnForm, setTxnForm] = useState({
    bankAccountId: '', transactionDate: new Date().toISOString().split('T')[0],
    description: '', reference: '', amount: 0, type: 'CREDIT',
  })
  const [reconForm, setReconForm] = useState({
    bankAccountId: '', statementDate: new Date().toISOString().split('T')[0],
    statementBalance: 0, reconciledBalance: 0,
  })
  const [transferForm, setTransferForm] = useState({
    fromAccountId: '', toAccountId: '', date: new Date().toISOString().split('T')[0], amount: 0, reference: '',
  })
  const [chequeForm, setChequeForm] = useState({
    bankAccountId: '', chequeNo: '', payee: '', amount: 0,
    issueDate: new Date().toISOString().split('T')[0],
  })

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const supplierName = params.get('supplierName')
    if (params.get('new') !== '1' || params.get('tab') !== 'cheques' || !supplierName) return
    const timer = window.setTimeout(() => {
      setTab('cheques')
      setChequeForm({ bankAccountId: selectedAccountId || accounts[0]?.id || '', chequeNo: '', payee: supplierName, amount: 0, issueDate: new Date().toISOString().split('T')[0] })
      setShowChequeModal(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [accounts, selectedAccountId])

  async function load() {
    setLoading(true)
    const accountParams = new URLSearchParams({ active: 'false' })
    const txnParams = new URLSearchParams()
    if (selectedAccountId) txnParams.set('bankAccountId', selectedAccountId)

    const [aRes, tRes, rRes, xRes, cRes] = await Promise.all([
      fetch(`/api/banking/accounts?${accountParams}`),
      fetch(`/api/banking/transactions?${txnParams}`),
      fetch(`/api/banking/reconciliations${selectedAccountId ? `?bankAccountId=${selectedAccountId}` : ''}`),
      fetch('/api/banking/transfers'),
      fetch(`/api/banking/cheques${selectedAccountId ? `?bankAccountId=${selectedAccountId}` : ''}`),
    ])

    if (aRes.ok) setAccounts(await aRes.json())
    if (tRes.ok) setTransactions(await tRes.json())
    if (rRes.ok) setReconciliations(await rRes.json())
    if (xRes.ok) setTransfers(await xRes.json())
    if (cRes.ok) setCheques(await cRes.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [selectedAccountId])

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id.slice(0, 8)

  async function saveAccount() {
    setSaving(true)
    const res = await fetch('/api/banking/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(accountForm) })
    if (!res.ok) alert(await readApiError(res))
    else { setShowAccountModal(false); load() }
    setSaving(false)
  }

  async function saveTransaction() {
    setSaving(true)
    const res = await fetch('/api/banking/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(txnForm) })
    if (!res.ok) alert(await readApiError(res))
    else { setShowTxnModal(false); load() }
    setSaving(false)
  }

  async function saveReconciliation() {
    setSaving(true)
    const res = await fetch('/api/banking/reconciliations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reconForm) })
    if (!res.ok) alert(await readApiError(res))
    else { setShowReconModal(false); load() }
    setSaving(false)
  }

  async function completeReconciliation(id: string) {
    const res = await fetch(`/api/banking/reconciliations/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMPLETED', reconciledBalance: reconciliations.find((r) => r.id === id)?.statementBalance }),
    })
    if (!res.ok) alert(await readApiError(res))
    else load()
  }

  async function saveTransfer() {
    setSaving(true)
    const res = await fetch('/api/banking/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(transferForm) })
    if (!res.ok) alert(await readApiError(res))
    else { setShowTransferModal(false); load() }
    setSaving(false)
  }

  async function saveCheque() {
    setSaving(true)
    const res = await fetch('/api/banking/cheques', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chequeForm) })
    if (!res.ok) alert(await readApiError(res))
    else { setShowChequeModal(false); load() }
    setSaving(false)
  }

  async function importCsv() {
    if (!selectedAccountId) { alert('Select a bank account filter first'); return }
    setSaving(true)
    const res = await fetch('/api/banking/transactions/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankAccountId: selectedAccountId, csv: csvText }),
    })
    if (!res.ok) alert(await readApiError(res))
    else { setShowImportModal(false); load() }
    setSaving(false)
  }

  async function markChequeCleared(id: string) {
    const res = await fetch('/api/banking/cheques', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'CLEARED' }),
    })
    if (!res.ok) alert(await readApiError(res))
    else load()
  }

  const totalBalance = accounts.filter((a) => a.isActive).reduce((s, a) => s + a.currentBalance, 0)

  const visibleTransactions = useMemo(() => transactions.filter((t) => {
    if (txnFilters.type && t.type !== txnFilters.type) return false
    if (txnFilters.status && t.status !== txnFilters.status) return false
    return inDateRange(t.transactionDate, txnFilters.from, txnFilters.to)
  }), [transactions, txnFilters])
  const accountExportColumns: ExportColumn<BankAccount>[] = [
    { header: 'Name', value: (a) => a.name }, { header: 'Bank', value: (a) => a.bankName }, { header: 'Account Number', value: (a) => a.accountNumber }, { header: 'Type', value: (a) => a.accountType },
    { header: 'Currency', value: (a) => a.currency }, { header: 'Balance', value: (a) => a.currentBalance, type: 'currency' }, { header: 'Status', value: (a) => a.isActive ? 'Active' : 'Inactive' },
  ]
  const txnExportColumns: ExportColumn<BankTransaction>[] = [
    { header: 'Date', value: (t) => t.transactionDate, type: 'date' }, { header: 'Account', value: (t) => t.bankAccount?.name }, { header: 'Description', value: (t) => t.description },
    { header: 'Reference', value: (t) => t.reference }, { header: 'Type', value: (t) => t.type }, { header: 'Currency', value: (t) => t.bankAccount?.currency },
    { header: 'Amount', value: (t) => t.amount, type: 'currency' }, { header: 'Status', value: (t) => t.status },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="Banking"
        subtitle={`${accounts.length} accounts · ${formatPrimary(totalBalance)} total balance`}
        breadcrumb={[{ label: 'Banking' }]}
        action={
          <div className="flex items-center gap-2">
            {tab === 'accounts' && <Button onClick={() => { setAccountForm({ name: '', bankName: '', accountNumber: '', currency: primaryCurrency, openingBalance: 0, accountType: 'BANK' }); setShowAccountModal(true) }}><Plus size={15} /> Add Account</Button>}
            {tab === 'transactions' && (
              <>
                <Button variant="outline" onClick={() => setShowImportModal(true)}><Upload size={14} /> Import CSV</Button>
                <Button onClick={() => { setTxnForm({ bankAccountId: selectedAccountId || accounts[0]?.id || '', transactionDate: new Date().toISOString().split('T')[0], description: '', reference: '', amount: 0, type: 'CREDIT' }); setShowTxnModal(true) }}><Plus size={15} /> Add Transaction</Button>
              </>
            )}
            {tab === 'reconciliation' && <Button onClick={() => { setReconForm({ bankAccountId: selectedAccountId || accounts[0]?.id || '', statementDate: new Date().toISOString().split('T')[0], statementBalance: 0, reconciledBalance: 0 }); setShowReconModal(true) }}><Plus size={15} /> New Reconciliation</Button>}
            {tab === 'transfers' && <Button onClick={() => setShowTransferModal(true)}><ArrowLeftRight size={14} /> New Transfer</Button>}
            {tab === 'cheques' && <Button onClick={() => { setChequeForm({ bankAccountId: selectedAccountId || accounts[0]?.id || '', chequeNo: '', payee: '', amount: 0, issueDate: new Date().toISOString().split('T')[0] }); setShowChequeModal(true) }}><Plus size={15} /> Issue Cheque</Button>}
          </div>
        }
      />

      <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={cn('px-4 py-2 text-sm font-medium rounded-t-lg transition-colors', tab === t.id ? 'bg-white border border-b-white border-slate-200 text-indigo-600 -mb-px' : 'text-slate-500 hover:text-slate-700')}>
            {t.label}
          </button>
        ))}
      </div>

      <FilterBar>
        <Select value={selectedAccountId} onChange={(e) => setSelectedAccountId(e.target.value)} className="w-auto min-w-[200px]">
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <button onClick={load} className="p-2 border border-slate-200 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-50 bg-white transition-colors">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
        {tab === 'accounts' && <ExportMenu filename="bank-accounts" sheetName="Bank Accounts" columns={accountExportColumns} rows={accounts} />}
        {tab === 'transactions' && <ExportMenu filename="bank-transactions" sheetName="Bank Transactions" columns={txnExportColumns} rows={visibleTransactions} meta={['Bank Transactions', `Account: ${accounts.find((a) => a.id === selectedAccountId)?.name ?? 'All accounts'}`]} />}
      </FilterBar>
      {tab === 'transactions' && <FilterPanel applied={txnFilters} onApply={setTxnFilters} fields={[{ key: 'type', label: 'Type', type: 'select', allLabel: 'All types', options: [...new Set(transactions.map((t) => t.type))].sort().map((x) => ({ value: x, label: x })) }, { key: 'status', label: 'Status', type: 'select', allLabel: 'All statuses', options: [...new Set(transactions.map((t) => t.status))].sort().map((x) => ({ value: x, label: x })) }, { key: 'from', label: 'Date from', type: 'date' }, { key: 'to', label: 'Date to', type: 'date' }]} />}

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {tab === 'accounts' && (
          <table className="w-full data-table">
            <thead><tr className="border-b border-slate-100">{['Name', 'Bank', 'Account #', 'Type', 'Currency', 'Balance', 'Status'].map((h) => <th key={h} className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase text-left">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-50">
              {accounts.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3 font-semibold text-slate-800">{a.name}</td>
                  <td className="px-4 py-3 text-sm text-slate-500">{a.bankName ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{a.accountNumber ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{a.accountType}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{a.currency}</td>
                  <td className="px-4 py-3 font-semibold tabular text-sm">{formatAmount(a.currentBalance, a.currency)}</td>
                  <td className="px-4 py-3"><Badge status={a.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'transactions' && (
          <table className="w-full data-table">
            <thead><tr className="border-b border-slate-100">{['Date', 'Account', 'Description', 'Type', 'Amount', 'Status'].map((h) => <th key={h} className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase text-left">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-50">
              {visibleTransactions.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(t.transactionDate)}</td>
                  <td className="px-4 py-3 text-sm text-slate-700">{t.bankAccount?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-sm text-slate-800">{t.description}</td>
                  <td className="px-4 py-3 text-xs"><Badge status={t.type} /></td>
                  <td className={cn('px-4 py-3 font-semibold tabular text-sm', t.type === 'CREDIT' ? 'text-emerald-600' : 'text-rose-600')}>
                    {t.type === 'CREDIT' ? '+' : '-'}{formatAmount(t.amount, t.bankAccount?.currency ?? primaryCurrency)}
                  </td>
                  <td className="px-4 py-3"><Badge status={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'reconciliation' && (
          <table className="w-full data-table">
            <thead><tr className="border-b border-slate-100">{['Statement Date', 'Account', 'Statement Bal.', 'Reconciled', 'Status', ''].map((h) => <th key={h} className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase text-left">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-50">
              {reconciliations.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(r.statementDate)}</td>
                  <td className="px-4 py-3 text-sm">{r.bankAccount?.name ?? '—'}</td>
                  <td className="px-4 py-3 tabular text-sm">{formatAmount(r.statementBalance, r.bankAccount?.currency ?? primaryCurrency)}</td>
                  <td className="px-4 py-3 tabular text-sm">{formatAmount(r.reconciledBalance, r.bankAccount?.currency ?? primaryCurrency)}</td>
                  <td className="px-4 py-3"><Badge status={r.status} /></td>
                  <td className="px-4 py-3">
                    {r.status === 'IN_PROGRESS' && (
                      <button onClick={() => completeReconciliation(r.id)} className="text-xs font-semibold text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded-lg">Complete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'transfers' && (
          <table className="w-full data-table">
            <thead><tr className="border-b border-slate-100">{['Transfer #', 'From', 'To', 'Date', 'Amount'].map((h) => <th key={h} className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase text-left">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-50">
              {transfers.map((x) => (
                <tr key={x.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3 font-mono text-xs text-indigo-600">{x.transferNo}</td>
                  <td className="px-4 py-3 text-sm">{accountName(x.fromAccountId)}</td>
                  <td className="px-4 py-3 text-sm">{accountName(x.toAccountId)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(x.date)}</td>
                  <td className="px-4 py-3 font-semibold tabular text-sm">{formatPrimary(x.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'cheques' && (
          <table className="w-full data-table">
            <thead><tr className="border-b border-slate-100">{['Cheque #', 'Payee', 'Account', 'Issue Date', 'Amount', 'Status', ''].map((h) => <th key={h} className="px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase text-left">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-50">
              {cheques.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-3 font-mono text-xs text-indigo-600">{c.chequeNo}</td>
                  <td className="px-4 py-3 text-sm font-medium">{c.payee}</td>
                  <td className="px-4 py-3 text-sm text-slate-500">{c.bankAccount?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(c.issueDate)}</td>
                  <td className="px-4 py-3 font-semibold tabular text-sm">{formatPrimary(c.amount)}</td>
                  <td className="px-4 py-3"><Badge status={c.status} /></td>
                  <td className="px-4 py-3">
                    {c.status === 'ISSUED' && (
                      <button onClick={() => markChequeCleared(c.id)} className="text-xs font-semibold text-emerald-600 hover:bg-emerald-50 px-2 py-1 rounded-lg">Mark Cleared</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && (
          (tab === 'accounts' && accounts.length === 0) ||
          (tab === 'transactions' && transactions.length === 0) ||
          (tab === 'reconciliation' && reconciliations.length === 0) ||
          (tab === 'transfers' && transfers.length === 0) ||
          (tab === 'cheques' && cheques.length === 0)
        ) && (
          <div className="px-4 py-16 text-center text-slate-400 text-sm">No records found.</div>
        )}
      </div>

      <Modal open={showAccountModal} onClose={() => setShowAccountModal(false)} title="Add Bank Account" size="md"
        footer={<><Button variant="outline" onClick={() => setShowAccountModal(false)}>Cancel</Button><Button onClick={saveAccount} loading={saving}>Save</Button></>}>
        <div className="space-y-4">
          <Input label="Account Name" required value={accountForm.name} onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })} />
          <Input label="Bank Name" value={accountForm.bankName} onChange={(e) => setAccountForm({ ...accountForm, bankName: e.target.value })} />
          <Input label="Account Number" value={accountForm.accountNumber} onChange={(e) => setAccountForm({ ...accountForm, accountNumber: e.target.value })} />
          <Select label="Currency" value={accountForm.currency} onChange={(e) => setAccountForm({ ...accountForm, currency: e.target.value })}>
            {ALLOWED_CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </Select>
          <Input label="Opening Balance" type="number" value={accountForm.openingBalance} onChange={(e) => setAccountForm({ ...accountForm, openingBalance: parseFloat(e.target.value) || 0 })} />
        </div>
      </Modal>

      <Modal open={showTxnModal} onClose={() => setShowTxnModal(false)} title="Add Transaction" size="md"
        footer={<><Button variant="outline" onClick={() => setShowTxnModal(false)}>Cancel</Button><Button onClick={saveTransaction} loading={saving}>Save</Button></>}>
        <div className="space-y-4">
          <Select label="Account" required value={txnForm.bankAccountId} onChange={(e) => setTxnForm({ ...txnForm, bankAccountId: e.target.value })}>
            <option value="">Select...</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Input label="Date" type="date" value={txnForm.transactionDate} onChange={(e) => setTxnForm({ ...txnForm, transactionDate: e.target.value })} />
          <Input label="Description" required value={txnForm.description} onChange={(e) => setTxnForm({ ...txnForm, description: e.target.value })} />
          <Select label="Type" value={txnForm.type} onChange={(e) => setTxnForm({ ...txnForm, type: e.target.value })}>
            <option value="CREDIT">Credit (deposit)</option>
            <option value="DEBIT">Debit (withdrawal)</option>
          </Select>
          <Input label="Amount" type="number" min="0" value={txnForm.amount} onChange={(e) => setTxnForm({ ...txnForm, amount: parseFloat(e.target.value) || 0 })} />
          <Input label="Reference" value={txnForm.reference} onChange={(e) => setTxnForm({ ...txnForm, reference: e.target.value })} />
        </div>
      </Modal>

      <Modal open={showReconModal} onClose={() => setShowReconModal(false)} title="Start Reconciliation" size="md"
        footer={<><Button variant="outline" onClick={() => setShowReconModal(false)}>Cancel</Button><Button onClick={saveReconciliation} loading={saving}>Start</Button></>}>
        <div className="space-y-4">
          <Select label="Account" required value={reconForm.bankAccountId} onChange={(e) => setReconForm({ ...reconForm, bankAccountId: e.target.value })}>
            <option value="">Select...</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Input label="Statement Date" type="date" value={reconForm.statementDate} onChange={(e) => setReconForm({ ...reconForm, statementDate: e.target.value })} />
          <Input label="Statement Balance" type="number" value={reconForm.statementBalance} onChange={(e) => setReconForm({ ...reconForm, statementBalance: parseFloat(e.target.value) || 0 })} />
        </div>
      </Modal>

      <Modal open={showTransferModal} onClose={() => setShowTransferModal(false)} title="Bank Transfer" size="md"
        footer={<><Button variant="outline" onClick={() => setShowTransferModal(false)}>Cancel</Button><Button onClick={saveTransfer} loading={saving}>Transfer</Button></>}>
        <div className="space-y-4">
          <Select label="From Account" required value={transferForm.fromAccountId} onChange={(e) => setTransferForm({ ...transferForm, fromAccountId: e.target.value })}>
            <option value="">Select...</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Select label="To Account" required value={transferForm.toAccountId} onChange={(e) => setTransferForm({ ...transferForm, toAccountId: e.target.value })}>
            <option value="">Select...</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Input label="Date" type="date" value={transferForm.date} onChange={(e) => setTransferForm({ ...transferForm, date: e.target.value })} />
          <Input label="Amount" type="number" min="0" value={transferForm.amount} onChange={(e) => setTransferForm({ ...transferForm, amount: parseFloat(e.target.value) || 0 })} />
          <Input label="Reference" value={transferForm.reference} onChange={(e) => setTransferForm({ ...transferForm, reference: e.target.value })} />
        </div>
      </Modal>

      <Modal open={showChequeModal} onClose={() => setShowChequeModal(false)} title="Issue Cheque" size="md"
        footer={<><Button variant="outline" onClick={() => setShowChequeModal(false)}>Cancel</Button><Button onClick={saveCheque} loading={saving}>Issue</Button></>}>
        <div className="space-y-4">
          <Select label="Bank Account" required value={chequeForm.bankAccountId} onChange={(e) => setChequeForm({ ...chequeForm, bankAccountId: e.target.value })}>
            <option value="">Select...</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <Input label="Cheque Number" required value={chequeForm.chequeNo} onChange={(e) => setChequeForm({ ...chequeForm, chequeNo: e.target.value })} />
          <Input label="Payee" required value={chequeForm.payee} onChange={(e) => setChequeForm({ ...chequeForm, payee: e.target.value })} />
          <Input label="Amount" type="number" min="0" value={chequeForm.amount} onChange={(e) => setChequeForm({ ...chequeForm, amount: parseFloat(e.target.value) || 0 })} />
          <Input label="Issue Date" type="date" value={chequeForm.issueDate} onChange={(e) => setChequeForm({ ...chequeForm, issueDate: e.target.value })} />
        </div>
      </Modal>

      <Modal open={showImportModal} onClose={() => setShowImportModal(false)} title="Import Bank Feed (CSV)" size="lg"
        footer={<><Button variant="outline" onClick={() => setShowImportModal(false)}>Cancel</Button><Button onClick={importCsv} loading={saving}>Import</Button></>}>
        <p className="text-xs text-slate-500 mb-3">CSV columns: date, description, amount (or debit/credit). Importing into: {selectedAccountId ? accountName(selectedAccountId) : 'select an account filter first'}</p>
        <Textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={10} className="font-mono text-xs" />
      </Modal>
    </div>
  )
}
