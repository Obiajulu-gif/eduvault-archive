export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * User-facing support access notices.
 *
 * Returns the signed-in user's active support sessions in sanitized form —
 * scopes, window, and reason, never actor identifiers or token material — so
 * account holders can see when support access is (or recently was) active.
 * Reading your own notices never counts as a support "use".
 */

import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { requireActiveUser } from '@/lib/api/auth'
import { COLLECTIONS } from '@/lib/backend/schemaContracts'
import { buildSupportNotice, toUserSafeNotice } from '@/lib/auth/supportAccess'

export async function GET(request) {
  const auth = await requireActiveUser(request)
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 403 ? 'Account suspended' : 'Unauthorized' },
      { status: auth.status },
    )
  }

  try {
    const db = await getDb()
    const now = new Date()
    const sessions = await db
      .collection(COLLECTIONS.supportSessions)
      .find({
        targetUserId: String(auth.user._id),
        status: 'active',
        expiresAt: { $gt: now },
      })
      .sort({ createdAt: -1 })
      .toArray()

    return NextResponse.json({
      sessions: sessions.map(toUserSafeNotice),
      notices: sessions.map((session) => buildSupportNotice(session, { now })),
    })
  } catch (error) {
    console.error('GET /api/support/sessions error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
