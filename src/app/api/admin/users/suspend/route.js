export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongodb'
import { verifyDashboardToken } from '@/lib/auth/session'
import { auditLog } from '@/lib/api/audit'
import { sendSuspensionEmail, sendReactivationEmail } from '@/lib/email/suspensionNotifier'
import { appendAuditRecord } from '@/lib/backend/auditLedger'

async function getAdminUser(request) {
  const cookieHeader = request.headers.get('cookie') || ''
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/)
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null
  if (!token) return null
  const verification = await verifyDashboardToken(token, process.env.JWT_SECRET)
  if (!verification.valid) return null
  return verification.payload
}

/**
 * POST /api/admin/users/suspend
 *
 * Body:
 *   {
 *     userId: string,          // MongoDB _id of the target user
 *     action: "suspend" | "reactivate",
 *     reason?: string          // Required when action === "suspend"
 *   }
 *
 * Suspends or reactivates a user account and dispatches a notification email.
 */
export async function POST(request) {
  try {
    const admin = await getAdminUser(request)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { userId, action, reason } = body

    if (!userId || !action) {
      return NextResponse.json({ error: 'userId and action are required.' }, { status: 400 })
    }

    if (!['suspend', 'reactivate'].includes(action)) {
      return NextResponse.json({ error: 'action must be "suspend" or "reactivate".' }, { status: 400 })
    }

    if (action === 'suspend' && !reason) {
      return NextResponse.json({ error: 'reason is required when suspending an account.' }, { status: 400 })
    }

    if (!ObjectId.isValid(userId)) {
      return NextResponse.json({ error: 'Invalid userId.' }, { status: 400 })
    }

    const db = await getDb()
    const users = db.collection('users')
    const targetUser = await users.findOne({ _id: new ObjectId(userId) })

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 })
    }

    const isSuspending = action === 'suspend'
    const newStatus = isSuspending ? 'suspended' : 'active'

    await users.updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          status: newStatus,
          ...(isSuspending
            ? { suspendedAt: new Date().toISOString(), suspensionReason: reason, suspendedBy: admin.sub }
            : { reactivatedAt: new Date().toISOString(), reactivatedBy: admin.sub, suspensionReason: null }),
          updatedAt: new Date().toISOString(),
        },
      }
    )

    await appendAuditRecord({
      db,
      operationId: request.headers.get('x-idempotency-key') || `${action}:${userId}:${targetUser.status || 'active'}:${admin.sub}`,
      actor: admin.sub,
      action: `user.${action}`,
      target: { type: 'user', id: userId },
      intent: { action, reason },
      result: { status: newStatus },
      reason,
    })

    auditLog({
      event: isSuspending ? 'user_suspended' : 'user_reactivated',
      route: 'admin/users/suspend',
      method: 'POST',
      status: 200,
      actor: admin.sub,
      target: userId,
      reason: reason || null,
    })

    // Dispatch notification email — non-blocking; log failures without failing the request
    const recipientEmail = targetUser.email
    const recipientName = targetUser.fullName || targetUser.name || 'there'

    let emailSent = false
    if (recipientEmail) {
      try {
        if (isSuspending) {
          await sendSuspensionEmail({ to: recipientEmail, name: recipientName, reason })
        } else {
          await sendReactivationEmail({ to: recipientEmail, name: recipientName })
        }
        emailSent = true
        console.log(JSON.stringify({ level: 'info', event: 'suspension_email_sent', to: recipientEmail, action, timestamp: new Date().toISOString() }))
      } catch (emailErr) {
        console.error(JSON.stringify({ level: 'error', event: 'suspension_email_failed', to: recipientEmail, error: emailErr.message, timestamp: new Date().toISOString() }))
      }
    }

    return NextResponse.json({ success: true, status: newStatus, emailSent })
  } catch (err) {
    auditLog({ event: 'user_suspend_error', route: 'admin/users/suspend', method: 'POST', status: 500, reason: err.message })
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
