import { round2 } from './drilldown-math'

export interface TraceLine { amount: number; taxRate: number }

export interface ArithmeticCheck {
  lineSubtotal: number
  expectedTax: number
  expectedTotal: number
  checks: Array<{ label: string; stored: number; computed: number; ok: boolean }>
  ok: boolean
}

/**
 * Re-derives a document's subtotal / tax / total from its lines and compares with the stored header,
 * so the user can see whether the saved arithmetic reconciles. Mismatches are reported, not corrected.
 * Tax is the sum of each line's own tax (line amount × line rate) — the same basis the posting uses.
 */
export function checkDocumentArithmetic(
  lines: TraceLine[],
  header: { subtotal: number | null; taxAmount: number | null; total: number | null },
): ArithmeticCheck {
  const lineSubtotal = round2(lines.reduce((s, l) => s + l.amount, 0))
  const expectedTax = round2(lines.reduce((s, l) => s + (l.amount * l.taxRate) / 100, 0))
  const expectedTotal = round2(lineSubtotal + expectedTax)
  const checks: ArithmeticCheck['checks'] = []
  const add = (label: string, stored: number | null, computed: number) => {
    if (stored === null) return
    checks.push({ label, stored: round2(stored), computed, ok: Math.abs(round2(stored) - computed) < 0.02 })
  }
  add('Subtotal = sum of line amounts', header.subtotal, lineSubtotal)
  add('Tax = sum of line taxes', header.taxAmount, expectedTax)
  add('Total = subtotal + tax', header.total, header.subtotal !== null && header.taxAmount !== null ? round2(header.subtotal + header.taxAmount) : expectedTotal)
  return { lineSubtotal, expectedTax, expectedTotal, checks, ok: checks.every((c) => c.ok) }
}

export function ledgerBalance(entries: Array<{ debit: number; credit: number }>): { debit: number; credit: number; balanced: boolean } {
  const debit = round2(entries.reduce((s, e) => s + e.debit, 0))
  const credit = round2(entries.reduce((s, e) => s + e.credit, 0))
  return { debit, credit, balanced: Math.abs(debit - credit) < 0.01 }
}
