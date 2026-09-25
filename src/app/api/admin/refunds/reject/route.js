export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getDb } from '@/lib/mongodb';
import { requireAdmin } from '@/lib/api/auth';
import { rejectRefund } from '@/lib/refunds/refundWorkflow';

/**
 * Deny a requested (or permanently failed) refund claim (Issue #27).
 * Terminal — a rejected claim never moves money and a new claim must be
 * filed if the buyer disputes the decision.
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
    if (!reason || typeof reason !== 'string') {
      return NextResponse.json({ error: 'A reason is required to reject a refund claim' }, { status: 400 });
    }

    const db = await getDb();
    const actor = admin.walletAddress || admin.sub;

    const result = await rejectRefund({
      db,
      refundId: new ObjectId(refundId),
      actor,
      reason: reason.slice(0, 500),
    });

    if (!result.success) {
      const status = result.reason === 'refund_not_found' ? 404 : 409;
      return NextResponse.json({ error: result.reason, refund: result.refund }, { status });
    }

    return NextResponse.json({ success: true, refund: result.refund });
  } catch (error) {
    console.error('POST /api/admin/refunds/reject error:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
