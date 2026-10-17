export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongodb'
import { requireAdmin } from '@/lib/api/auth'
import { appendAuditRecord } from '@/lib/backend/auditLedger'
import {
  computePermissionDiff,
  validateRoleTransition,
  VALID_ROLES,
} from '@/lib/auth/permissionDiff'
import { revokeUserSessions, SECURITY_EVENT_TYPES } from '@/lib/auth/sessionRevocation'

const ALLOWED_ROLES = new Set(VALID_ROLES)

/**
 * GET /api/admin/users/role?userId=...&targetRole=...
 * Dry-run preview of a proposed role change and its permission diff report.
 */
export async function GET(request) {
  const admin = await requireAdmin(request)
  if (!admin) return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 })

  try {
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('userId')
    const targetRole = searchParams.get('targetRole')

    if (!userId || !ObjectId.isValid(userId) || !targetRole || !ALLOWED_ROLES.has(targetRole)) {
      return NextResponse.json(
        { error: 'Valid userId and targetRole query parameters are required.' },
        { status: 400 }
      )
    }

    const db = await getDb()
    const users = db.collection('users')
    const target = await users.findOne({ _id: new ObjectId(userId) })
    if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 })

    const diffReport = computePermissionDiff({
      currentRole: target.role || 'user',
      targetRole,
      actor: admin.walletAddress || admin.sub,
      targetUserId: userId,
    })

    return NextResponse.json({
      preview: true,
      currentRole: target.role || 'user',
      targetRole,
      diffReport,
    })
  } catch (error) {
    console.error('GET /api/admin/users/role error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

/**
 * POST /api/admin/users/role
 * Executes a role change or previews it if dryRun is specified.
 */
export async function POST(request) {
  const admin = await requireAdmin(request)
  if (!admin) return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 })

  try {
    const body = await request.json()
    const {
      userId,
      role,
      reason = null,
      dryRun = false,
      preview = false,
      confirmElevatedRisk = false,
    } = body

    if (!userId || !ObjectId.isValid(userId) || !ALLOWED_ROLES.has(role)) {
      return NextResponse.json({ error: 'userId and a valid role are required.' }, { status: 400 })
    }

    const actor = admin.walletAddress || admin.sub
    const validation = validateApproval({
      approval,
      requiredScope: APPROVAL_SCOPES.USER_ROLE_CHANGE,
      actor,
    })
    if (!validation.valid) {
      return NextResponse.json({ error: validation.code }, { status: 403 })
    }

    const db = await getDb()
    const users = db.collection('users')
    const target = await users.findOne({ _id: new ObjectId(userId) })
    if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 })

    const transition = validateRoleTransition({
      adminActor: admin,
      targetUser: target,
      newRole: role,
      confirmElevatedRisk: Boolean(confirmElevatedRisk),
    })

    // If dry run or preview requested, return report without modifying DB
    if (dryRun || preview) {
      return NextResponse.json({
        preview: true,
        allowed: transition.allowed,
        diffReport: transition.diffReport,
        requiresConfirmation: transition.status === 428,
      }, { status: transition.status || 200 })
    }

    if (!transition.allowed) {
      return NextResponse.json(
        { error: transition.error, diffReport: transition.diffReport },
        { status: transition.status || 400 }
      )
    }

const diff = computePermissionDiff({
      actor: target.walletAddress || target.email || userId,
      fromRole: target.role,
      toRole: role,
    })

    // Broad changes (sensitive permissions or many permissions) must be
    // explicitly confirmed by the caller.
    try {
      assertConfirmation(diff, confirm)
    } catch (confirmError) {
      return NextResponse.json(
        {
          error: confirmError.message,
          code: confirmError.code,
          diff,
        },
        { status: confirmError.status || 428 },
      )
    }

    const actor = admin.walletAddress || admin.sub
    await users.updateOne(
      { _id: new ObjectId(userId), role: target.role },
      { $set: { role, updatedAt: new Date() } },
    )

    await revokeUserSessions(db, userId, {
      eventType: SECURITY_EVENT_TYPES.ROLE_CHANGED,
      reason: `Role changed from ${target.role} to ${role}`,
      actor,
    })

    await appendAuditRecord({
      db,
      operationId: request.headers.get('x-idempotency-key') || `role:${userId}:${target.role}:${role}:${actor}`,
      actor: actor,
      action: 'user.role_changed',
      target: { type: 'user', id: userId },
      intent: {
        previousRole: target.role,
        newRole: role,
        diffReport: transition.diffReport,
      },
      result: {
        previousRole: target.role,
        newRole: role,
        diffReport: transition.diffReport,
      },
      reason,
      approval: validation.approval,
    })

    return NextResponse.json({
      success: true,
      previousRole: target.role,
      role,
      diffReport: transition.diffReport,
    })
  } catch (error) {
    console.error('POST /api/admin/users/role error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
