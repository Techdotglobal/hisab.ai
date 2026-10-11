'use client'

import { useEffect, useState } from 'react'
import { Plus, Edit2, UserX, ShieldCheck } from 'lucide-react'
import { formatDate, cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Input, Select } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { readApiError } from '@/lib/api-client'

interface User {
  id: string; name: string; email: string; role: string; isActive: boolean; createdAt: string
}

interface CurrentUser {
  id: string; role: string
}

/** Assignable through Create/Edit User. Owner is never assignable here — see Transfer Ownership. */
const ROLES = ['ADMIN', 'ACCOUNTANT', 'VIEWER']

/** Non-owner roles the current Owner may move into when transferring ownership away. */
const POST_TRANSFER_ROLES = ['ADMIN', 'ACCOUNTANT', 'MANAGER', 'EMPLOYEE', 'VIEWER']

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  ACCOUNTANT: 'Accountant',
  MANAGER: 'Manager',
  EMPLOYEE: 'Employee',
  VIEWER: 'Viewer',
}

const roleColors: Record<string, string> = {
  SUPER_ADMIN: 'bg-amber-50 text-amber-700 border border-amber-200',
  ADMIN: 'bg-violet-50 text-violet-700 border border-violet-200',
  ACCOUNTANT: 'bg-indigo-50 text-indigo-700 border border-indigo-200',
  MANAGER: 'bg-sky-50 text-sky-700 border border-sky-200',
  EMPLOYEE: 'bg-teal-50 text-teal-700 border border-teal-200',
  VIEWER: 'bg-slate-50 text-slate-600 border border-slate-200',
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [me, setMe] = useState<CurrentUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'ACCOUNTANT' })
  const [showTransferModal, setShowTransferModal] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [transferForm, setTransferForm] = useState({ newOwnerUserId: '', previousOwnerNewRole: 'ACCOUNTANT' })

  const isSuperAdmin = me?.role === 'SUPER_ADMIN'

  async function load() {
    setLoading(true)
    const [usersRes, meRes] = await Promise.all([fetch('/api/users'), fetch('/api/auth/me')])
    if (usersRes.ok) setUsers(await usersRes.json())
    if (meRes.ok) setMe(await meRes.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function openCreate() {
    setEditing(null)
    setForm({ name: '', email: '', password: '', role: 'ACCOUNTANT' })
    setShowModal(true)
  }

  function openEdit(u: User) {
    setEditing(u)
    setForm({ name: u.name || '', email: u.email, password: '', role: u.role })
    setShowModal(true)
  }

  async function handleSave() {
    setSaving(true)
    const url = editing ? `/api/users/${editing.id}` : '/api/users'
    // Owner's role is never editable here (see Transfer Ownership) — omit it so editing the
    // Owner's own name doesn't send role: 'SUPER_ADMIN', which the server correctly rejects.
    const body = editing
      ? (editing.role === 'SUPER_ADMIN' ? { name: form.name } : { name: form.name, role: form.role })
      : form
    const res = await fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) {
      alert(await readApiError(res))
      setSaving(false)
      return
    }
    if (res.ok) { setShowModal(false); load() }
    setSaving(false)
  }

  async function handleDeactivate(id: string) {
    if (!confirm('Deactivate this user?')) return
    const res = await fetch(`/api/users/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: false }) })
    if (!res.ok) {
      alert(await readApiError(res))
      return
    }
    load()
  }

  function openTransfer() {
    setTransferForm({ newOwnerUserId: '', previousOwnerNewRole: 'ACCOUNTANT' })
    setShowTransferModal(true)
  }

  async function handleTransfer() {
    if (!transferForm.newOwnerUserId) {
      alert('Select the user who will become Owner.')
      return
    }
    if (!confirm('Transfer ownership? You will no longer be Owner after this.')) return
    setTransferring(true)
    const res = await fetch('/api/users/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(transferForm),
    })
    if (!res.ok) {
      alert(await readApiError(res))
      setTransferring(false)
      return
    }
    setShowTransferModal(false)
    setTransferring(false)
    load()
  }

  const transferCandidates = users.filter((u) => u.role !== 'SUPER_ADMIN' && u.isActive)

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-5">
      <PageHeader
        title="User Management"
        subtitle={`${users.length} users`}
        breadcrumb={[{ label: 'Administration' }, { label: 'Users' }]}
        action={
          <div className="flex items-center gap-2">
            {isSuperAdmin && (
              <Button variant="outline" onClick={openTransfer}>
                <ShieldCheck size={15} /> Transfer Ownership
              </Button>
            )}
            <Button onClick={openCreate}><Plus size={15} /> Create User</Button>
          </div>
        }
      />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full data-table">
            <thead>
              <tr className="border-b border-slate-100">
                {['Name', 'Email', 'Role', 'Status', 'Created', ''].map((h, i) => (
                  <th key={i} className={cn('px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-left', h === 'Status' && 'text-center', h === '' && 'w-20')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 6 }).map((_, j) => <td key={j} className="px-4 py-3"><div className="skeleton h-4 rounded" /></td>)}</tr>
              )) : users.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-400 text-sm">No users found.</td></tr>
              ) : users.map(u => {
                const canManage = u.role !== 'SUPER_ADMIN' || isSuperAdmin
                return (
                  <tr key={u.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center flex-shrink-0">
                          <span className="text-white text-xs font-bold">{(u.name || u.email)[0].toUpperCase()}</span>
                        </div>
                        <span className="font-semibold text-slate-800 text-sm">{u.name || '—'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{u.email}</td>
                    <td className="px-4 py-3"><span className={cn('badge', roleColors[u.role] || roleColors.VIEWER)}>{ROLE_LABELS[u.role] || u.role}</span></td>
                    <td className="px-4 py-3 text-center"><Badge status={u.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                    <td className="px-4 py-3 text-xs text-slate-400">{formatDate(u.createdAt)}</td>
                    <td className="px-4 py-3">
                      {canManage && (
                        <div className="flex items-center gap-1">
                          <button onClick={() => openEdit(u)} className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"><Edit2 size={13} /></button>
                          {u.isActive && u.role !== 'SUPER_ADMIN' && <button onClick={() => handleDeactivate(u.id)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"><UserX size={13} /></button>}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showModal} onClose={() => setShowModal(false)}
        title={editing ? 'Edit User' : 'Create User'} size="sm"
        footer={<><Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button><Button onClick={handleSave} loading={saving}>{editing ? 'Update' : 'Create'}</Button></>}
      >
        <div className="space-y-4">
          <Input label="Full Name" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <Input label="Email" type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} disabled={!!editing} />
          {!editing && <Input label="Password" type="password" required value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />}
          {editing?.role === 'SUPER_ADMIN' ? (
            <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3">
              Owner&apos;s role can only be changed through Transfer Ownership.
            </div>
          ) : (
            <Select label="Role" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
              {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
            </Select>
          )}
          <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 space-y-1">
            <p><strong>Admin</strong> — Full access, manage users</p>
            <p><strong>Accountant</strong> — Create & edit all financial records</p>
            <p><strong>Viewer</strong> — Read-only access to reports</p>
          </div>
        </div>
      </Modal>

      <Modal open={showTransferModal} onClose={() => setShowTransferModal(false)}
        title="Transfer Ownership" size="sm"
        footer={<><Button variant="outline" onClick={() => setShowTransferModal(false)}>Cancel</Button><Button onClick={handleTransfer} loading={transferring}>Transfer</Button></>}
      >
        <div className="space-y-4">
          <Select label="New Owner" value={transferForm.newOwnerUserId} onChange={e => setTransferForm({ ...transferForm, newOwnerUserId: e.target.value })}>
            <option value="">— Select user —</option>
            {transferCandidates.map(u => <option key={u.id} value={u.id}>{u.name || u.email} ({u.email})</option>)}
          </Select>
          <Select label="Your new role after transfer" value={transferForm.previousOwnerNewRole} onChange={e => setTransferForm({ ...transferForm, previousOwnerNewRole: e.target.value })}>
            {POST_TRANSFER_ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
          </Select>
          <div className="text-xs text-slate-500 bg-amber-50 border border-amber-100 rounded-lg p-3">
            The selected user becomes Owner immediately. You will hold the role chosen above instead. This cannot be undone from this screen — the new Owner would need to transfer it back.
          </div>
        </div>
      </Modal>
    </div>
  )
}
