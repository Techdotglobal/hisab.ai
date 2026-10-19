import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import {
  deleteCompanyLogoFile,
  inferLogoMimeType,
  rasterizeCompanyLogoToPng,
  uploadCompanyLogoPng,
  validateCompanyLogoFile,
} from '@/lib/branding'
import { stripLogoCacheBuster } from '@/lib/branding/logo-url'
import { getSettingsRepository } from '@/lib/db/provider'

async function handlePost(request: Request) {
  try {
    await requireAuth()
    const formData = await request.formData()
    const file = formData.get('file')

    if (!(file instanceof File)) {
      return Response.json({ error: 'No logo file provided' }, { status: 400 })
    }

    const validationError = validateCompanyLogoFile(file)
    if (validationError) {
      return Response.json({ error: validationError }, { status: 400 })
    }

    const settingsRepo = getSettingsRepository()
    const existing = await settingsRepo.findFirst()
    if (!existing) {
      return Response.json({ error: 'Company settings not found' }, { status: 404 })
    }

    const mime = inferLogoMimeType(file)
    const rawBuffer = Buffer.from(await file.arrayBuffer())
    const pngBuffer = await rasterizeCompanyLogoToPng(rawBuffer, mime)

    if (existing.logoStoragePath) {
      await deleteCompanyLogoFile(existing.logoStoragePath)
    }

    const { storagePath, publicUrl } = await uploadCompanyLogoPng(existing.id, pngBuffer)
    const uploadedAt = new Date()

    const updated = await settingsRepo.update(existing.id, {
      logoUrl: publicUrl,
      logoStoragePath: storagePath,
      logoUploadedAt: uploadedAt,
    })

    const logoUploadedAt = updated.logoUploadedAt?.toISOString() ?? uploadedAt.toISOString()

    return Response.json({
      logoUrl: stripLogoCacheBuster(updated.logoUrl),
      logoStoragePath: updated.logoStoragePath,
      logoUploadedAt,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[branding] logo upload failed:', error)
    return Response.json({ error: 'Failed to upload logo' }, { status: 500 })
  }
}

async function handleDelete() {
  try {
    await requireAuth()
    const settingsRepo = getSettingsRepository()
    const existing = await settingsRepo.findFirst()
    if (!existing) {
      return Response.json({ error: 'Company settings not found' }, { status: 404 })
    }

    if (existing.logoStoragePath) {
      await deleteCompanyLogoFile(existing.logoStoragePath)
    }

    const updated = await settingsRepo.update(existing.id, {
      logoUrl: null,
      logoStoragePath: null,
      logoUploadedAt: null,
    })

    return Response.json({
      logoUrl: updated.logoUrl,
      logoStoragePath: updated.logoStoragePath,
      logoUploadedAt: null,
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[branding] logo removal failed:', error)
    return Response.json({ error: 'Failed to remove logo' }, { status: 500 })
  }
}

export const POST = guarded('settings.manage', handlePost)
export const DELETE = guarded('settings.manage', handleDelete)
