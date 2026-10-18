export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Revoke a support session (admin side).
 *
 * Any admin may revoke any session (incident response must not depend on the
 * original maintainer being reachable); the revoking admin's identity is
 * recorded in the audit ledger. Revoked sessions stop resolving immediately
 * and the caller's cookie is cleared.
 */

import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { requireAdmin } from '@/lib/api/auth'
import { SUPPORT_SESSION_COOKIE, revokeSupportSession, toUserSafeNotice } from '@/lib/auth/supportAccess'

export async function DELETE(request, { params }) {
  const admin = await requireAdmin(request)
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 })
  }

  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const { reason = null, clearCookie = true } = body || {}

    const db = await getDb()
    const result = await revokeSupportSession({
      db,
      sessionId: id,
      revokedBy: admin.sub,
      reason,
    })

    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409
      return NextResponse.json({ error: result.error }, { status })
    }

    const response = NextResponse.json({ success: true, session: toUserSafeNotice(result.session) })
    if (clearCookie) {
      response.cookies.set(SUPPORT_SESSION_COOKIE, '', {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 0,
      })
    }
    return response
  } catch (error) {
    console.error('DELETE /api/admin/support-sessions/[id] error:', error)
    return NextResponse.json({ error: error?.message || 'Internal Server Error', code: error?.code || null }, { status: 500 })
  }
}
