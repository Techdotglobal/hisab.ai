import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { deleteCompanyRow, getCompanyRow, insertCompanyRow, listCompanyRows, updateCompanyRow } from '@/lib/api/crud'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'

async function handleGet(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const entityType = searchParams.get('entityType')
    const entityId = searchParams.get('entityId')

    if (entityId) {
      const companyId = await resolveCompanyId()
      const client = createAdminClient()
      const { data, error } = await client
        .from('custom_field_values')
        .select('*, definition:custom_field_definitions(*)')
        .eq('company_id', companyId)
        .eq('entity_id', entityId)
      if (error) throw error
      return Response.json(data ?? [])
    }

    const rows = await listCompanyRows('custom_field_definitions', {
      orderBy: 'entity_type',
      ascending: true,
      filters: entityType ? { entity_type: entityType } : undefined,
    })
    return Response.json(rows)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()

    if (body.value) {
      if (!body.definitionId || !body.entityId) {
        return Response.json({ error: 'definitionId and entityId required for values' }, { status: 400 })
      }
      const companyId = await resolveCompanyId()
      const client = createAdminClient()
      const { data, error } = await client
        .from('custom_field_values')
        .upsert({
          company_id: companyId,
          definition_id: body.definitionId,
          entity_id: body.entityId,
          value: body.value.value ?? body.value,
        }, { onConflict: 'definition_id,entity_id' })
        .select('*')
        .single()
      if (error) throw error
      return Response.json(data, { status: 201 })
    }

    if (!body.entityType || !body.fieldKey || !body.fieldLabel) {
      return Response.json({ error: 'entityType, fieldKey, fieldLabel are required' }, { status: 400 })
    }

    const row = await insertCompanyRow('custom_field_definitions', {
      entity_type: body.entityType,
      field_key: body.fieldKey,
      field_label: body.fieldLabel,
      field_type: body.fieldType ?? 'TEXT',
      is_required: body.isRequired ?? false,
    })
    return Response.json(row, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePut(request: Request) {
  try {
    await requireAuth()
    const body = await request.json()
    if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 })

    const existing = await getCompanyRow('custom_field_definitions', body.id)
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

    const row = await updateCompanyRow('custom_field_definitions', body.id, {
      entity_type: body.entityType ?? existing.entity_type,
      field_key: body.fieldKey ?? existing.field_key,
      field_label: body.fieldLabel ?? existing.field_label,
      field_type: body.fieldType ?? existing.field_type,
      is_required: body.isRequired ?? existing.is_required,
    })
    return Response.json(row)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handleDelete(request: Request) {
  try {
    await requireAuth()
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 })
    await deleteCompanyRow('custom_field_definitions', id)
    return Response.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
export const POST = guarded('platform.manage', handlePost)
export const PUT = guarded('platform.manage', handlePut)
export const DELETE = guarded('platform.manage', handleDelete)
