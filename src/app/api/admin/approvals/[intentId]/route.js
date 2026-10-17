export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { requireAdmin } from '@/lib/api/auth';
import {
  loadApprovalIntent,
  loadApprovalReceipt,
  createSignedReceipt,
  persistApprovalReceipt,
  ApprovalFlowError,
} from '@/lib/approvals/maintainerApprovalFlow';

/**
 * GET /api/admin/approvals/{intentId}
 *
 * Returns the stored intent and, once produced, its signed receipt — so a
 * maintainer action executor (or a reviewer) can check decision status.
 */
export async function GET(request, { params }) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
  }

  const { intentId } = await params;
  const db = await getDb();
  const intent = await loadApprovalIntent(db, intentId);
  if (!intent) {
    return NextResponse.json({ error: 'Approval intent not found or expired.' }, { status: 404 });
  }
  const receipt = await loadApprovalReceipt(db, intentId);

  return NextResponse.json({ success: true, intent, receipt });
}

/**
 * POST /api/admin/approvals/{intentId}
 *
 * Submits a second maintainer's wallet signature over the intent's signing
 * message, verifies it, and — only if valid — persists a signed receipt
 * to the audit ledger. The caller submitting the signature is taken as the
 * approver, so an approver cannot submit a signature on behalf of someone
 * else's wallet.
 *
 * Request Body:
 * {
 *   signatureHex: string,     // hex-encoded Ed25519 signature
 *   decision: "approved" | "rejected",
 * }
 */
export async function POST(request, { params }) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
  }

  const { intentId } = await params;

  try {
    const { signatureHex, decision } = await request.json();
    const db = await getDb();

    const intent = await loadApprovalIntent(db, intentId);
    if (!intent) {
      return NextResponse.json({ error: 'Approval intent not found or expired.' }, { status: 404 });
    }

    const receipt = createSignedReceipt({
      intent,
      approverAddress: admin.walletAddress,
      signatureHex,
      decision,
    });

    await persistApprovalReceipt(db, { intent, receipt });

    return NextResponse.json({ success: true, receipt });
  } catch (error) {
    if (error instanceof ApprovalFlowError) {
      return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
    }
    console.error('POST /api/admin/approvals/[intentId] error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
