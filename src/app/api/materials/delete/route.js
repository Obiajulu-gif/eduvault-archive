export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongodb'
import { auditLog } from '@/lib/api/audit'
import { requireActiveUser, requireAdmin } from '@/lib/api/auth'
import { recordAdminAction } from '@/lib/db/adminAudit'
import { ADMIN_AUDIT_ACTIONS } from '@/lib/db/schemas/auditLog'
import { restoreMaterial, softDeleteMaterial } from '@/lib/db/softDelete'
import { enqueueMaterialSearchProjection } from '@/lib/backend/materialSearchProjection'

/**
 * POST /api/materials/delete
 *
 * Body:
 *   {
 *     materialId: string,
 *     action?: "delete" | "restore",   // defaults to "delete"
 *     reason?: string
 *   }
 *
 * Retires a catalog listing without removing the document.
 *
 * Hard deletion is not offered here on purpose: purchasers hold entitlements
 * that resolve through this material's storage key, and removing the row would
 * break every one of those download references while leaving the purchase rows
 * behind. Setting `isDeleted` hides the listing from the public catalog and
 * leaves entitlement-backed downloads working.
 *
 * Authorization: the owning creator, or an admin. Admin actions additionally
 * append a row to the administrative audit log.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}))
    const { materialId, action = 'delete', reason } = body || {}

    if (!materialId) {
      return NextResponse.json({ error: 'materialId is required.' }, { status: 400 })
    }

    if (!['delete', 'restore'].includes(action)) {
      return NextResponse.json(
        { error: 'action must be "delete" or "restore".' },
        { status: 400 }
      )
    }

    const admin = await requireAdmin(request)
    let actorId = admin?.sub || null

    // Non-admins must be an active (non-suspended) session before they can
    // touch a listing at all.
    let actingUser = null
    if (!admin) {
      const session = await requireActiveUser(request)
      if (!session.ok) {
        return NextResponse.json(
          {
            error: session.status === 403 ? 'Account suspended' : 'Unauthorized',
          },
          { status: session.status }
        )
      }
      actingUser = session.user
      actorId = actingUser._id?.toString() || null
    }

    const db = await getDb()

    // Resolve by either identifier the collection uses.
    const idFilter = ObjectId.isValid(materialId)
      ? { $or: [{ materialId }, { _id: new ObjectId(materialId) }] }
      : { materialId }

    // A creator may only retire their own listing; an admin may retire any.
    const filter = admin
      ? idFilter
      : {
          ...idFilter,
          $and: [
            {
              $or: [
                { userAddress: actingUser?.walletAddress },
                { userAddress: actingUser?.walletAddressLower },
                { creatorId: actingUser?._id?.toString() },
              ].filter((clause) => Object.values(clause)[0]),
            },
          ],
        }

    const result =
      action === 'delete'
        ? await softDeleteMaterial({ db, filter, deletedBy: actorId, reason })
        : await restoreMaterial({ db, filter })

    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409
      const message = {
        not_found: 'Material not found, or you do not have permission to modify it.',
        already_deleted: 'Material is already deleted.',
        not_deleted: 'Material is not deleted.',
      }[result.reason]
      return NextResponse.json({ error: message }, { status })
    }

    await enqueueMaterialSearchProjection({
      db,
      material: result.updatedMaterial,
      reason: action === 'delete' ? 'material_soft_deleted' : 'material_restored',
    })

    if (admin) {
      // Awaited before responding: an admin takedown that cannot be attributed
      // must not be reported as success.
      await recordAdminAction({
        db,
        adminId: admin.sub,
        targetUser: String(result.material?.userAddress || materialId),
        action:
          action === 'delete'
            ? ADMIN_AUDIT_ACTIONS.MATERIAL_SOFT_DELETED
            : ADMIN_AUDIT_ACTIONS.MATERIAL_RESTORED,
        reason,
        metadata: { materialId: String(materialId) },
      })
    }

    auditLog({
      event: action === 'delete' ? 'material_soft_deleted' : 'material_restored',
      route: 'materials/delete',
      method: 'POST',
      status: 200,
      actor: actorId,
      materialId: String(materialId),
      reason: reason || null,
    })

    return NextResponse.json({
      success: true,
      materialId: String(materialId),
      isDeleted: action === 'delete',
    })
  } catch (err) {
    auditLog({
      event: 'material_delete_error',
      route: 'materials/delete',
      method: 'POST',
      status: 500,
      reason: err.message,
    })
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
