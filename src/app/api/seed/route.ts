import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { seedQaData } from '@/lib/qa-seed'

function isQaSeedEnabled(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.ENABLE_QA_SEED === 'true'
}

async function handlePost() {
  if (!isQaSeedEnabled()) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    await requireAuth()
    const qa = await seedQaData()

    return Response.json({
      success: true,
      message: qa.message,
      qa,
    })
  } catch (error) {
    console.error('Seed error:', error)
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

export const POST = guarded('settings.manage', handlePost)
