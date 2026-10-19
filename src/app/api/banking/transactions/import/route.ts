import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { toCamel } from '@/lib/api/db-transform'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

function parseCsvLine(line: string): string[] {
  const values: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === ',' && !inQuotes) {
      values.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  values.push(current.trim())
  return values
}

function normalizeHeader(header: string) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const companyId = await resolveCompanyId()
    const body = await request.json()
    const { bankAccountId, csv } = body

    if (!bankAccountId || !csv || typeof csv !== 'string') {
      return Response.json({ error: 'bankAccountId and csv are required' }, { status: 400 })
    }

    const lines = csv.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean)
    if (lines.length < 2) {
      return Response.json({ error: 'CSV must include a header row and at least one transaction' }, { status: 400 })
    }

    const headers = parseCsvLine(lines[0]).map(normalizeHeader)
    const dateIdx = headers.findIndex((h) => ['date', 'transactiondate', 'valuedate'].includes(h))
    const descIdx = headers.findIndex((h) => ['description', 'narration', 'details', 'memo'].includes(h))
    const amountIdx = headers.findIndex((h) => ['amount', 'value'].includes(h))
    const debitIdx = headers.findIndex((h) => h === 'debit')
    const creditIdx = headers.findIndex((h) => h === 'credit')
    const refIdx = headers.findIndex((h) => ['reference', 'ref', 'referenceno'].includes(h))

    if (dateIdx < 0 || descIdx < 0 || (amountIdx < 0 && debitIdx < 0 && creditIdx < 0)) {
      return Response.json({
        error: 'CSV must include date, description, and amount (or debit/credit) columns',
      }, { status: 400 })
    }

    const client = createAdminClient()
    const { data: account, error: accountError } = await client
      .from('bank_accounts')
      .select('id')
      .eq('id', bankAccountId)
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .maybeSingle()

    if (accountError) throw accountError
    if (!account) return Response.json({ error: 'Bank account not found' }, { status: 404 })

    const rows: Array<Record<string, unknown>> = []
    const errors: string[] = []
    let balanceDelta = 0

    for (let i = 1; i < lines.length; i += 1) {
      const cols = parseCsvLine(lines[i])
      const dateValue = cols[dateIdx]
      const description = cols[descIdx]
      if (!dateValue || !description) {
        errors.push(`Row ${i + 1}: missing date or description`)
        continue
      }

      let amount = 0
      let type: 'DEBIT' | 'CREDIT' = 'DEBIT'

      if (amountIdx >= 0) {
        amount = Math.abs(parseFloat(cols[amountIdx]) || 0)
        const raw = cols[amountIdx].replace(/,/g, '')
        const signed = parseFloat(raw) || 0
        amount = Math.abs(signed)
        type = signed < 0 ? 'DEBIT' : 'CREDIT'
      } else {
        const debit = parseFloat((cols[debitIdx] ?? '0').replace(/,/g, '')) || 0
        const credit = parseFloat((cols[creditIdx] ?? '0').replace(/,/g, '')) || 0
        if (debit > 0) {
          amount = debit
          type = 'DEBIT'
        } else if (credit > 0) {
          amount = credit
          type = 'CREDIT'
        }
      }

      if (amount <= 0) {
        errors.push(`Row ${i + 1}: invalid amount`)
        continue
      }

      rows.push({
        company_id: companyId,
        bank_account_id: bankAccountId,
        transaction_date: new Date(dateValue).toISOString(),
        description,
        reference: refIdx >= 0 ? (cols[refIdx] || null) : null,
        amount,
        type,
        status: 'UNMATCHED',
        imported_from: 'CSV',
      })

      balanceDelta += type === 'CREDIT' ? amount : -amount
    }

    if (rows.length === 0) {
      return Response.json({ error: 'No valid rows to import', errors }, { status: 400 })
    }

    const { data, error } = await client
      .from('bank_transactions')
      .insert(rows)
      .select('*')

    if (error) throw error

    if (balanceDelta !== 0) {
      const { data: current, error: balError } = await client
        .from('bank_accounts')
        .select('current_balance')
        .eq('id', bankAccountId)
        .eq('company_id', companyId)
        .single()

      if (balError) throw balError

      const { error: updateError } = await client
        .from('bank_accounts')
        .update({
          current_balance: Number(current.current_balance) + balanceDelta,
          updated_at: new Date().toISOString(),
        })
        .eq('id', bankAccountId)
        .eq('company_id', companyId)

      if (updateError) throw updateError
    }

    return Response.json({
      imported: data?.length ?? 0,
      errors,
      transactions: toCamel(data ?? []),
    }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const POST = guarded('banking.edit', handlePost)
