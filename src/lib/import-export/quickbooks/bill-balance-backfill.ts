/**
 * Guarded plan for the one-off NETKOM imported-bill balance backfill.
 *
 * Imported bills were created without `amount_paid`/`balance` (DB default 0) and only an allocation refresh corrects them,
 * so bills that never received an allocation stayed at balance 0 and vanished from AP aging. The correct state for a bill
 * with no allocations is amount_paid = 0, balance = total (the allocation invariant below).
 *
 * This module only decides; it never touches the database. It refuses to plan anything unless the target set is exactly the
 * reviewed one, so a changed system aborts instead of being "fixed".
 */

export interface BillBackfillTarget { legacyId: string; total: number }

/** The exact 14 bills reviewed on 2026-09-21 (sum 528,874.84). */
export const REVIEWED_BILL_BACKFILL_TARGETS: readonly BillBackfillTarget[] = [
  { legacyId: '5006', total: 136932.8 }, { legacyId: '4835', total: 110325.25 }, { legacyId: '4599', total: 71207 },
  { legacyId: '4836', total: 60750.68 }, { legacyId: '4840', total: 43707.35 }, { legacyId: '4770', total: 36977.24 },
  { legacyId: '4839', total: 28759.21 }, { legacyId: '4838', total: 21016.8 }, { legacyId: '2624', total: 8004 },
  { legacyId: '2358', total: 4778.8 }, { legacyId: '2359', total: 3267.01 }, { legacyId: '2514', total: 1579.41 },
  { legacyId: '2494', total: 1467.4 }, { legacyId: '4837', total: 101.89 },
]
export const REVIEWED_BILL_BACKFILL_TOTAL_CENTS = 52887484

export interface BillRow { id: string; legacy_id: string | null; total: number | string; amount_paid: number | string; balance: number | string; deleted_at?: string | null }

/** Everything that would make the backfill unsafe, counted per bill id. */
export interface BillDependencies {
  allocations: Record<string, number>
  creditAllocations: Record<string, number>
  payments: Record<string, number>
  vendorCredits: Record<string, number>
  nonBillLedgerRows: Record<string, number>
}

export interface BillBackfillPlan {
  ok: boolean
  aborts: string[]
  /** Bills to update: set amount_paid = 0, balance = total. */
  updates: Array<{ id: string; legacyId: string; total: number }>
  /** Bills already in the corrected state (idempotent no-op). */
  alreadyCorrect: string[]
}

const cents = (value: number | string) => Math.round(Number(value) * 100)

/** balance = max(total - sum(allocations), 0), amount_paid = min(sum(allocations), total). */
export function billAllocationInvariant(total: number | string, allocationSum: number | string) {
  const totalCents = cents(total), appliedCents = cents(allocationSum)
  return { amountPaid: Math.min(appliedCents, totalCents) / 100, balance: Math.max(totalCents - appliedCents, 0) / 100 }
}

export function planBillBalanceBackfill(input: {
  targets?: readonly BillBackfillTarget[]
  reviewedTotalCents?: number
  bills: BillRow[]
  dependencies: BillDependencies
}): BillBackfillPlan {
  const targets = input.targets ?? REVIEWED_BILL_BACKFILL_TARGETS
  const reviewedTotal = input.reviewedTotalCents ?? REVIEWED_BILL_BACKFILL_TOTAL_CENTS
  const aborts: string[] = [], updates: BillBackfillPlan['updates'] = [], alreadyCorrect: string[] = []

  if (targets.length !== 14) aborts.push(`Reviewed target list has ${targets.length} entries; expected exactly 14.`)
  if (targets.reduce((sum, item) => sum + cents(item.total), 0) !== reviewedTotal) aborts.push('Reviewed target totals do not sum to the reviewed amount.')

  const byLegacy = new Map<string, BillRow[]>()
  for (const bill of input.bills) {
    const key = String(bill.legacy_id ?? '')
    byLegacy.set(key, [...(byLegacy.get(key) ?? []), bill])
  }
  const found = targets.filter((target) => (byLegacy.get(target.legacyId) ?? []).length > 0).length
  if (found !== targets.length) aborts.push(`Found ${found} of ${targets.length} target bills.`)

  for (const target of targets) {
    const rows = byLegacy.get(target.legacyId) ?? []
    if (rows.length === 0) continue
    if (rows.length !== 1) { aborts.push(`Bill ${target.legacyId}: ${rows.length} rows share the legacy id; expected exactly 1.`); continue }
    const bill = rows[0]
    if (bill.deleted_at) { aborts.push(`Bill ${target.legacyId}: is deleted.`); continue }
    if (cents(bill.total) !== cents(target.total)) { aborts.push(`Bill ${target.legacyId}: total ${Number(bill.total)} differs from the reviewed ${target.total}.`); continue }

    const blockers = ([
      ['payment allocations', input.dependencies.allocations],
      ['credit allocations naming this bill', input.dependencies.creditAllocations],
      ['linked payments', input.dependencies.payments],
      ['linked vendor credits', input.dependencies.vendorCredits],
      ['non-BILL ledger rows', input.dependencies.nonBillLedgerRows],
    ] as const).filter(([, counts]) => (counts[bill.id] ?? 0) > 0).map(([label, counts]) => `${counts[bill.id]} ${label}`)
    if (blockers.length) { aborts.push(`Bill ${target.legacyId}: has ${blockers.join(', ')} since the reviewed analysis.`); continue }

    const paid = cents(bill.amount_paid), balance = cents(bill.balance), total = cents(bill.total)
    if (paid === 0 && balance === 0) updates.push({ id: bill.id, legacyId: target.legacyId, total: total / 100 })
    else if (paid === 0 && balance === total) alreadyCorrect.push(target.legacyId)
    else aborts.push(`Bill ${target.legacyId}: unexpected state amount_paid=${Number(bill.amount_paid)} balance=${Number(bill.balance)}; expected the defective (0, 0) or corrected (0, total) state.`)
  }

  return { ok: aborts.length === 0, aborts, updates: aborts.length ? [] : updates, alreadyCorrect: aborts.length ? [] : alreadyCorrect }
}
