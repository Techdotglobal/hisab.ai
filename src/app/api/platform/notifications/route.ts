import { guarded } from '@/lib/permissions/guard'
import { requireAuth } from '@/lib/auth'
import { listNotifications, markRead, markAllRead, getUnreadCount, upsertPreference } from '@/lib/platform/notifications/service'

async function handleGet(request: Request) {
  try {
    const user = await requireAuth()
    const { searchParams } = new URL(request.url)
    const unreadOnly = searchParams.get('unread') === 'true'

    if (searchParams.get('count') === 'true') {
      const count = await getUnreadCount(user.id)
      return Response.json({ count })
    }

    const notifications = await listNotifications(user.id, undefined, unreadOnly)
    return Response.json({ notifications })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

async function handlePatch(request: Request) {
  try {
    const user = await requireAuth()
    const body = await request.json()

    if (body.markAllRead) {
      await markAllRead(user.id)
      return Response.json({ success: true })
    }

    if (body.notificationId) {
      await markRead(body.notificationId, user.id)
      return Response.json({ success: true })
    }

    if (body.preference) {
      const pref = await upsertPreference({
        userId: user.id,
        category: body.preference.category,
        channel: body.preference.channel,
        isEnabled: body.preference.isEnabled,
      })
      return Response.json(pref)
    }

    return Response.json({ error: 'Invalid request' }, { status: 400 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return Response.json({ error: String(error) }, { status: 500 })
  }
}

export const GET = guarded('dashboard.view', handleGet)
export const PATCH = guarded('platform.manage', handlePatch)
