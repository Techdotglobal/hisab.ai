import { createAdminClient } from '@/lib/supabase/admin'
import { billAllocationInvariant, planBillBalanceBackfill, REVIEWED_BILL_BACKFILL_TARGETS, type BillDependencies, type BillRow } from '@/lib/import-export/quickbooks/bill-balance-backfill'

// One-off NETKOM backfill of 14 imported bills stored with amount_paid = 0 and balance = 0.
// DEFAULT IS A DRY RUN. Writes happen only with --execute, and only after every guard passes.
const C = '05585a44-672d-4bab-aa40-6dfe022c19a0'
const EXECUTE = process.argv.includes('--execute')
const db = createAdminClient()
type Row = Record<string, unknown>
const one = async (q: PromiseLike<{ data: unknown; error: { message: string } | null }>) => { const r = await q; if (r.error) throw new Error(r.error.message); return (r.data ?? []) as Row[] }
const count = (rows: Row[], key: string) => rows.reduce((m: Record<string, number>, r) => { const k = String(r[key]); m[k] = (m[k] ?? 0) + 1; return m }, {})

async function pageAll(table: string, columns: string) {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const rows = await one(db.from(table).select(columns).eq('company_id', C).order('id').range(from, from + 999))
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

async function readPlan() {
  const legacyIds = REVIEWED_BILL_BACKFILL_TARGETS.map((t) => t.legacyId)
  const bills = (await one(db.from('bills').select('id,legacy_id,total,amount_paid,balance,deleted_at').eq('company_id', C).in('legacy_id', legacyIds))) as unknown as BillRow[]
  const ids = bills.map((b) => b.id)
  const [allocations, allAllocations, payments, vendorCredits, ledger] = await Promise.all([
    one(db.from('payment_allocations').select('bill_id').eq('company_id', C).in('bill_id', ids)),
    pageAll('payment_allocations', 'id,local_credit_ids'),
    one(db.from('payments').select('bill_id').eq('company_id', C).in('bill_id', ids)),
    one(db.from('vendor_credits').select('bill_id').eq('company_id', C).in('bill_id', ids)),
    one(db.from('ledger_entries').select('source_id,source_type').eq('company_id', C).in('source_id', ids).neq('source_type', 'BILL')),
  ])
  const creditAllocations: Record<string, number> = {}
  for (const a of allAllocations) for (const id of (a.local_credit_ids ?? []) as string[]) if (ids.includes(id)) creditAllocations[id] = (creditAllocations[id] ?? 0) + 1
  const dependencies: BillDependencies = { allocations: count(allocations, 'bill_id'), creditAllocations, payments: count(payments, 'bill_id'), vendorCredits: count(vendorCredits, 'bill_id'), nonBillLedgerRows: count(ledger, 'source_id') }
  return { bills, plan: planBillBalanceBackfill({ bills, dependencies }) }
}

async function main() {
  const { plan } = await readPlan()
  console.log(`mode: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} | guards ok: ${plan.ok} | to update: ${plan.updates.length} | already correct: ${plan.alreadyCorrect.length}`)
  if (!plan.ok) { for (const a of plan.aborts) console.log('ABORT:', a); process.exit(2) }
  for (const u of plan.updates) console.log(`  ${EXECUTE ? 'updating' : 'would update'} bill ${u.legacyId}: amount_paid 0 -> 0, balance 0 -> ${u.total}`)
  if (!EXECUTE) { console.log('Dry run only. Nothing was written.'); return }

  for (const u of plan.updates) {
    // Compare-and-set: only touches the row while it is still in the reviewed defective state.
    const result = await db.from('bills').update({ amount_paid: 0, balance: u.total }).eq('company_id', C).eq('id', u.id).eq('amount_paid', 0).eq('balance', 0).select('id')
    if (result.error) throw new Error(`Bill ${u.legacyId}: ${result.error.message}`)
    if ((result.data ?? []).length !== 1) { console.error(`Bill ${u.legacyId}: row changed during the run; stopping. Re-run the dry run to reassess.`); process.exit(3) }
  }

  // Independent verification with fresh reads.
  const after = await readPlan()
  const bad = after.bills.filter((b) => { const inv = billAllocationInvariant(b.total, 0); return Math.abs(Number(b.balance) - inv.balance) > 0.005 || Math.abs(Number(b.amount_paid) - inv.amountPaid) > 0.005 })
  console.log(`verification: ${after.bills.length} bills read, ${bad.length} still violate the invariant, second-run plan updates ${after.plan.updates.length} (expected 0)`)
  if (bad.length || after.plan.updates.length) process.exit(4)
}
main().catch((e) => { console.error(e); process.exit(1) })
