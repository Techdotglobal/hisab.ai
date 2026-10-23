import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCompanyId } from '@/lib/tenant'
import type { DocumentStatus } from '../types'

export async function getDocumentWithDetails(documentId: string, companyId?: string) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const { data, error } = await client
    .from('documents')
    .select(`
      *,
      category:document_categories(id, name),
      versions:document_versions(*),
      tags:document_tag_assignments(tag:document_tags(id, name, color)),
      comments:document_comments(*, user:profiles(name:full_name)),
      ocr:document_ocr_metadata(*)
    `)
    .eq('id', documentId)
    .eq('company_id', cid)
    .single()
  if (error) throw error
  return data
}

export async function createDocumentVersion(input: {
  documentId: string
  fileName: string
  filePath: string
  mimeType: string
  fileSize?: number
  uploadedById?: string | null
  changeNote?: string
  companyId?: string
}) {
  const companyId = input.companyId ?? await resolveCompanyId()
  const client = createAdminClient()

  const { data: doc } = await client
    .from('documents')
    .select('current_version')
    .eq('id', input.documentId)
    .eq('company_id', companyId)
    .single()

  const versionNo = Number(doc?.current_version ?? 0) + 1

  const { data: version, error } = await client
    .from('document_versions')
    .insert({
      company_id: companyId,
      document_id: input.documentId,
      version_no: versionNo,
      file_name: input.fileName,
      file_path: input.filePath,
      mime_type: input.mimeType,
      file_size: input.fileSize ?? null,
      uploaded_by_id: input.uploadedById ?? null,
      change_note: input.changeNote ?? null,
    })
    .select('*')
    .single()

  if (error) throw error

  await client
    .from('documents')
    .update({
      current_version: versionNo,
      file_name: input.fileName,
      file_path: input.filePath,
      mime_type: input.mimeType,
    })
    .eq('id', input.documentId)

  return version
}

export async function archiveDocument(documentId: string, companyId?: string) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const { error } = await client
    .from('documents')
    .update({ status: 'ARCHIVED' as DocumentStatus, archived_at: new Date().toISOString() })
    .eq('id', documentId)
    .eq('company_id', cid)
  if (error) throw error
}

export async function addDocumentComment(documentId: string, body: string, userId: string, companyId?: string) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const { data, error } = await client
    .from('document_comments')
    .insert({ company_id: cid, document_id: documentId, user_id: userId, body })
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function linkDocuments(
  sourceId: string,
  targetId: string,
  relationshipType = 'RELATED',
  companyId?: string,
) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const { data, error } = await client
    .from('document_relationships')
    .insert({
      company_id: cid,
      source_document_id: sourceId,
      target_document_id: targetId,
      relationship_type: relationshipType,
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function saveOcrMetadata(input: {
  documentId: string
  versionId?: string | null
  provider?: string
  rawText?: string
  fields?: Record<string, unknown>
  confidence?: number
  companyId?: string
}) {
  const cid = input.companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const { data, error } = await client
    .from('document_ocr_metadata')
    .insert({
      company_id: cid,
      document_id: input.documentId,
      version_id: input.versionId ?? null,
      provider: input.provider ?? 'manual',
      raw_text: input.rawText ?? null,
      fields: input.fields ?? {},
      confidence: input.confidence ?? null,
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function applyRetentionPolicies(companyId?: string) {
  const cid = companyId ?? await resolveCompanyId()
  const client = createAdminClient()
  const { data: policies } = await client
    .from('document_retention_policies')
    .select('*')
    .eq('company_id', cid)
    .eq('is_active', true)

  let archived = 0
  for (const policy of policies ?? []) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - Number(policy.retain_days))
    const { data: docs } = await client
      .from('documents')
      .select('id')
      .eq('company_id', cid)
      .eq('retention_policy_id', policy.id)
      .eq('status', 'ACTIVE')
      .lt('created_at', cutoff.toISOString())

    for (const doc of docs ?? []) {
      if (policy.action_on_expiry === 'ARCHIVE') {
        await archiveDocument(doc.id, cid)
        archived += 1
      }
    }
  }
  return { archived }
}
