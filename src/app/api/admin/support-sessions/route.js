export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Time-bounded maintainer impersonation / support access (admin side).
 *
 * POST creates a scoped, expiring support session for a target user and sets
 * the session cookie on the caller's browser. Every creation is recorded in
 * the immutable audit ledger *before* the session exists — if the audit
 * append fails the request fails and no session is created.
 *
 * GET lists sessions started by the calling admin (own-session forensics).
 */

import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { requireAdmin } from '@/lib/api/auth'
import { COLLECTIONS } from '@/lib/backend/schemaContracts'
import {
  SUPPORT_SESSION_COOKIE,
  createSupportSession,
  toUserSafeNotice,
} from '@/lib/auth/supportAccess'

function errorStatus(code) {
  switch (code) {
    case 'target_not_found':
      return 404
    case 'not_admin':
    case 'actor_required':
    case 'target_suspended':
      return 403
    case 'target_required':
    case 'self_target_forbidden':
    case 'invalid_support_scopes':
    case 'support_reason_required':
      return 400
    default:
      return 500
  }
}

export async function POST(request) {
  const admin = await requireAdmin(request)
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const { userId, reason, scopes, ttlMinutes } = body

    const db = await getDb()
    const { session, token, notice } = await createSupportSession({
      db,
      actor: { id: admin.sub, role: admin.role, walletAddress: admin.walletAddress || admin.address || null },
      targetUserId: userId,
      reason,
      scopes,
      ttlMs: ttlMinutes !== undefined && ttlMinutes !== null ? Number(ttlMinutes) * 60_000 : undefined,
    })

    const response = NextResponse.json(
      {
        success: true,
        session: toUserSafeNotice(session),
        notice,
        expiresAt: session.expiresAt,
      },
      { status: 201 },
    )
    const maxAgeSeconds = Math.max(
      1,
      Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000),
    )
    response.cookies.set(SUPPORT_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: maxAgeSeconds,
    })
    return response
  } catch (error) {
    console.error('POST /api/admin/support-sessions error:', error)
    return NextResponse.json(
      { error: error?.message || 'Internal Server Error', code: error?.code || null },
      { status: errorStatus(error?.code) },
    )
  }
}

export async function GET(request) {
  const admin = await requireAdmin(request)
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 })
  }

  try {
    const url = new URL(request.url)
    const targetUserId = url.searchParams.get('targetUserId')
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25))

    const db = await getDb()
    const query = { actorId: String(admin.sub) }
    if (targetUserId) query.targetUserId = String(targetUserId)

    const sessions = await db
      .collection(COLLECTIONS.supportSessions)
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()

    return NextResponse.json({
      sessions: sessions.map((session) => ({
        ...toUserSafeNotice(session),
        actorId: session.actorId,
        targetUserId: session.targetUserId,
        revokedAt: session.revokedAt ? new Date(session.revokedAt).toISOString() : null,
        revokedBy: session.revokedBy || null,
      })),
    })
  } catch (error) {
    console.error('GET /api/admin/support-sessions error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
