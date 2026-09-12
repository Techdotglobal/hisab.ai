import 'server-only'
import { findSystemAccountByNameCandidates } from '@/lib/accounting/posting-service'
import type { PostingLine } from '@/lib/accounting/posting-service'
import type { ComputedTaxComponent } from './calculator'

export interface TaxJournalContext {
  companyId: string
  documentNo: string
  documentType: 'INVOICE' | 'BILL' | 'EXPENSE' | 'VENDOR_CREDIT' | 'SALES_RECEIPT'
  isSales: boolean
  components: ComputedTaxComponent[]
}

class MissingTaxAccountError extends Error {
  constructor(role: string, ctx: TaxJournalContext, componentName: string) {
    super(
      `Cannot post ${componentName} tax on ${ctx.documentType} ${ctx.documentNo}: ` +
      `no active ${role} account was found in the chart of accounts. ` +
      `Configure or rename an account so it can be resolved, then retry.`,
    )
    this.name = 'MissingTaxAccountError'
  }
}

/**
 * Build automatic tax journal lines from computed tax components.
 *
 * A required-but-unresolvable tax account throws (`MissingTaxAccountError`)
 * rather than silently omitting the line — a dropped tax line here does not
 * fail loudly on its own, it surfaces much later as a generic "Debits must
 * equal credits" ledger-balance error with no indication of the real cause.
 */
export async function buildTaxJournalLines(ctx: TaxJournalContext): Promise<PostingLine[]> {
  const lines: PostingLine[] = []
  // QuickBooks Online's Automated Sales Tax never exposes the underlying GL
  // accounts through its API, so which native account plays "VAT Payable" /
  // "VAT Receivable" is inherently a destination-side naming convention, not
  // something resolvable by QuickBooks identity. Try hisab.ai's own default
  // naming first, then the phrasing commonly seen in QuickBooks-migrated
  // charts of accounts (e.g. NETKOM's "INPUT VAT ON GOODS AND SERVICES").
  const vatPayable = await findSystemAccountByNameCandidates(ctx.companyId, ['VAT Payable', 'Output VAT', 'Sales Tax Payable'], { canonicalType: 'Liability' })
  const vatReceivable = await findSystemAccountByNameCandidates(ctx.companyId, ['VAT Receivable', 'Input VAT', 'Input Tax'], { canonicalType: 'Asset' })
  const withholdingPayable = await findSystemAccountByNameCandidates(ctx.companyId, ['Withholding'])

  for (const component of ctx.components) {
    if (component.taxAmount <= 0) continue

    const desc = `${component.name} ${ctx.documentNo}`
    const amount = component.taxAmount

    if (component.isWithholding) {
      if (!withholdingPayable) throw new MissingTaxAccountError('Withholding Payable', ctx, component.name)
      lines.push({
        accountId: withholdingPayable,
        credit: ctx.isSales ? amount : 0,
        debit: ctx.isSales ? 0 : amount,
        description: `WHT ${desc}`,
      })
      continue
    }

    if (component.isReverseCharge) {
      if (!vatReceivable) throw new MissingTaxAccountError('VAT Receivable', ctx, component.name)
      if (!vatPayable) throw new MissingTaxAccountError('VAT Payable', ctx, component.name)
      lines.push({ accountId: vatReceivable, debit: amount, description: `RC VAT ${desc}` })
      lines.push({ accountId: vatPayable, credit: amount, description: `RC VAT ${desc}` })
      continue
    }

    if (ctx.isSales) {
      if (!vatPayable) throw new MissingTaxAccountError('VAT Payable', ctx, component.name)
      lines.push({ accountId: vatPayable, credit: amount, description: desc })
    } else {
      if (!vatReceivable) throw new MissingTaxAccountError('VAT Receivable', ctx, component.name)
      lines.push({ accountId: vatReceivable, debit: amount, description: desc })
    }
  }

  return lines
}
