export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/mongodb';
import { requireAdmin } from '@/lib/api/auth';
import { approveRefund, processApprovedRefund } from '@/lib/refunds/refundWorkflow';

/**
 * Authorize a requested refund claim (Issue #27). This only performs the
 * `requested -> approved` transition — it never talks to Horizon in-request,
 * so the response is fast and the admin action can't be half-done by a
 * request timeout. Submission happens through the same idempotent
 * `processApprovedRefund` the background worker uses; it's also given one
 * best-effort inline attempt here so approval doesn't have to wait for the
 * next worker poll, but a failure to submit immediately is not an error —
 * the worker will pick it up on its next pass regardless.
 */
export async function POST(request) {
  try {
    const admin = await requireAdmin(request);
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const { refundId, reason } = body;

    if (!refundId || !ObjectId.isValid(refundId)) {
      return NextResponse.json({ error: 'Missing or invalid refundId' }, { status: 400 });
    }

    const db = await getDb();
    const actor = admin.walletAddress || admin.sub;

    const result = await approveRefund({
      db,
      refundId: new ObjectId(refundId),
      actor,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
    });

    if (!result.success) {
      const status = result.reason === 'refund_not_found' ? 404 : 409;
      return NextResponse.json({ error: result.reason, refund: result.refund }, { status });
    }

    processApprovedRefund({ db, refund: result.refund, actor }).catch(() => {
      // Best-effort — the worker's own poll loop will retry this refund.
    });

    return NextResponse.json({ success: true, refund: result.refund }, { status: 202 });
  } catch (error) {
    console.error('POST /api/admin/refunds/approve error:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
