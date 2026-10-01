export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { getDb } from '@/lib/mongodb'
import { requireAdmin } from '@/lib/api/auth'
import { appendAuditRecord } from '@/lib/backend/auditLedger'
import { APPROVAL_SCOPES, validateApproval } from '@/lib/admin/approval'
import {
  computePermissionDiff,
  assertConfirmation,
} from '@/lib/backend/permissionDiff'

const ALLOWED_ROLES = new Set(['admin', 'creator', 'learner', 'user'])

export async function POST(request) {
  const admin = await requireAdmin(request)
  if (!admin) return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 })

  try {
const { userId, role, reason = null, confirm = false, approval } = await request.json()
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
    if (target.role === role) return NextResponse.json({ error: 'User already has this role.' }, { status: 409 })

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
    await appendAuditRecord({
      db,
      operationId: request.headers.get('x-idempotency-key') || `role:${userId}:${target.role}:${role}:${actor}`,
      actor: actor,
      action: 'user.role_changed',
      target: { type: 'user', id: userId },
      intent: { previousRole: target.role, newRole: role, diff },
      result: { previousRole: target.role, newRole, role },
      reason,
      approval: validation.approval,
    })

    return NextResponse.json({ success: true, previousRole: target.role, role, diff })
  } catch (error) {
    console.error('POST /api/admin/users/role error:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
