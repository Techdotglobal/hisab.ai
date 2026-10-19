import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin,requireAccountingRead } from '@/lib/product-parity/permissions'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiError } from '@/lib/import-export/api-helpers'

async function handleGet() { try { const user = await requireAccountingRead(); const { data, error } = await createAdminClient().from('accounting_sync_changes').select('*').eq('company_id', user.companyId).eq('provider', 'quickbooks').eq('status', 'conflict').order('detected_at', { ascending: false }); if (error) throw error; return Response.json(data ?? []) } catch (error) { return apiError(error) } }
async function handlePatch(request: Request) { try { const user = await requireAccountingAdmin(); const body = await request.json() as { id?: string; resolution?: string }; if (!body.id || !['source_wins', 'hisab_wins', 'ignore'].includes(body.resolution ?? '')) return Response.json({ error: 'Conflict id and resolution are required.' }, { status: 400 }); const status = body.resolution === 'ignore' ? 'ignored' : 'detected'; const { data, error } = await createAdminClient().from('accounting_sync_changes').update({ status, resolution: body.resolution, resolved_at: new Date().toISOString() }).eq('id', body.id).eq('company_id', user.companyId).select('*').single(); if (error) throw error; return Response.json(data) } catch (error) { return apiError(error) } }

export const GET = guarded('imports.view', handleGet)
export const PATCH = guarded('integrations.manage', handlePatch)
