import { guarded } from '@/lib/permissions/guard'
import { requireAccountingAdmin,requireAccountingRead } from '@/lib/product-parity/permissions'
import { getQuickBooksSyncSettings, saveQuickBooksSyncSettings, syncQuickBooks } from '@/lib/accounting/quickbooks-sync'
import { apiError } from '@/lib/import-export/api-helpers'

async function handleGet() { try { const user = await requireAccountingRead(); return Response.json(await getQuickBooksSyncSettings(user.companyId)) } catch (error) { return apiError(error) } }
async function handlePatch(request: Request) { try { const user = await requireAccountingAdmin(); const body = await request.json(); return Response.json(await saveQuickBooksSyncSettings(user.companyId, body)) } catch (error) { return apiError(error) } }
async function handlePost(request: Request) { try { const user = await requireAccountingAdmin(); const body = await request.json(); return Response.json(await syncQuickBooks(user.companyId, user.id, body)) } catch (error) { return apiError(error) } }

export const GET = guarded('imports.view', handleGet)
export const POST = guarded('integrations.manage', handlePost)
export const PATCH = guarded('integrations.manage', handlePatch)
