export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api/auth';
import { ConfigAuditError, rollbackConfigChange } from '@/lib/config/adminConfigAudit';

/**
 * POST /api/admin/config/rollback
 * Reverts a previous administrative configuration change identified by evidenceId.
 * Generates an append-only rollback evidence entry preserving full history.
 *
 * Request Body:
 * {
 *   evidenceId: string,
 *   reason: string,
 *   approvalEvidence?: { approver: string, reason?: string },
 *   operationId?: string
 * }
 */
export async function POST(request) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { evidenceId, reason, approvalEvidence, operationId } = body;

    const opId = operationId || request.headers.get('x-idempotency-key') || undefined;

    const result = await rollbackConfigChange({
      evidenceId,
      reason,
      actor: admin,
      approvalEvidence,
      operationId: opId,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ConfigAuditError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          details: error.details,
        },
        { status: error.status || 400 }
      );
    }

    console.error('POST /api/admin/config/rollback error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
