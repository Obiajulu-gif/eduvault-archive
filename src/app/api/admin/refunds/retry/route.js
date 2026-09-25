export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/mongodb';
import { requireAdmin } from '@/lib/api/auth';
import { retryFailedRefund, processApprovedRefund } from '@/lib/refunds/refundWorkflow';

/**
 * Explicit admin recovery action for a refund that hit a terminal `failed`
 * state (e.g. treasury shortage after exhausting automatic retries) — an
 * intentional human decision, not something the worker loops on forever.
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

    const result = await retryFailedRefund({
      db,
      refundId: new ObjectId(refundId),
      actor,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.reason }, { status: 409 });
    }

    processApprovedRefund({ db, refund: result.refund, actor }).catch(() => {
      // Best-effort — the worker's own poll loop will retry this refund.
    });

    return NextResponse.json({ success: true, refund: result.refund }, { status: 202 });
  } catch (error) {
    console.error('POST /api/admin/refunds/retry error:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
