export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { requireAdmin } from '@/lib/api/auth';
import {
  createApprovalIntent,
  getApprovalSigningMessage,
  persistApprovalIntent,
  ApprovalFlowError,
} from '@/lib/approvals/maintainerApprovalFlow';

/**
 * POST /api/admin/approvals
 *
 * Proposes a high-impact maintainer action and returns the intent plus the
 * exact message a *different* maintainer must sign with their wallet to
 * approve it. This endpoint authorizes nothing by itself — the action
 * executor must separately call assertApprovalReceiptValid() with a signed
 * receipt from POST /api/admin/approvals/{intentId} before proceeding.
 *
 * Request Body:
 * {
 *   actionType: string,       // e.g. "ENTITLEMENT_REVOCATION"
 *   target: { type: string, id: string },
 *   payload?: object,         // minimal context for the approver to review
 *   reason: string,
 * }
 */
export async function POST(request) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { actionType, target, payload = {}, reason } = body;

    const intent = createApprovalIntent({
      actionType,
      actor: admin.walletAddress,
      target,
      payload,
      reason,
    });

    const db = await getDb();
    await persistApprovalIntent(db, intent);

    return NextResponse.json({
      success: true,
      intent,
      signingMessage: getApprovalSigningMessage(intent),
    });
  } catch (error) {
    if (error instanceof ApprovalFlowError) {
      return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
    }
    console.error('POST /api/admin/approvals error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
