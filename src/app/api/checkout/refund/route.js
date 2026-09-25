export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { getUserFromCookie } from '@/lib/api/auth';
import { requestRefund } from '@/lib/refunds/refundWorkflow';
import logger from '@/lib/logger';

const REASON_STATUS = {
  purchase_not_found: 404,
  not_purchase_owner: 403,
  invalid_purchase_id: 400,
};

/**
 * File a refund claim (Issue #27). This endpoint only accepts `purchaseId`,
 * an optional `reason`, and an optional `requestedAmount` (for a partial
 * refund) — destination, asset, network, and the actual refundable amount
 * are always derived server-side from the purchase record, never trusted
 * from the request body.
 */
export async function POST(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { purchaseId, reason, requestedAmount } = body;

    if (!purchaseId) {
      return NextResponse.json({ error: 'Missing purchaseId' }, { status: 400 });
    }

    const isAdmin = user.role === 'admin';
    const walletAddress = user.walletAddress || user.address || null;

    if (!isAdmin && !walletAddress) {
      return NextResponse.json({ error: 'Session has no wallet address' }, { status: 400 });
    }

    const db = await getDb();
    const result = await requestRefund({
      db,
      purchaseId,
      // Admins may file a claim on behalf of any buyer; a regular session is
      // only ever allowed to claim its own purchase (enforced inside requestRefund).
      buyerAddress: isAdmin ? null : walletAddress,
      actor: walletAddress || user.sub,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
      requestedAmount: requestedAmount ?? null,
    });

    if (!result.success) {
      const status = REASON_STATUS[result.reason] || 400;
      return NextResponse.json({ error: result.reason }, { status });
    }

    return NextResponse.json(
      {
        message: result.alreadyExists ? 'Refund claim already exists for this purchase' : 'Refund requested',
        refund: result.refund,
      },
      { status: result.alreadyExists ? 200 : 201 }
    );
  } catch (error) {
    logger.error({ err: error.message }, 'Failed to process refund request');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
