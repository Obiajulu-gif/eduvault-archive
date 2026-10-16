import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/auth';
import { getDb } from '@/lib/mongodb';
import { retryPartialFailure } from '@/lib/backend/partialFailures';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/partial-failures/retry
 *
 * Trigger safe idempotent retry of an unresolved partial failure.
 * Body: { failureId, reason }
 */
export async function POST(request) {
  try {
    const authorization = await requirePermission(request, 'operations:write');
    if (!authorization.ok) {
      return NextResponse.json({ error: 'Forbidden: operations write access required' }, { status: authorization.status });
    }

    const body = await request.json();
    const { failureId, reason } = body || {};

    if (!failureId) {
      return NextResponse.json({ error: 'failureId is required' }, { status: 400 });
    }

    const db = await getDb();
    const result = await retryPartialFailure(db, failureId, {
      actor: authorization.user?.address || authorization.user?.email || 'admin',
      reason: reason || 'Operator triggered manual retry from partial-failures dashboard',
    });

    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    console.error('[admin/partial-failures/retry] Failed to retry partial failure:', error);
    const status = error.message.includes('not found') ? 404 : error.message.includes('cannot be safely') ? 400 : 500;
    return NextResponse.json(
      { error: error.message || 'Internal Server Error' },
      { status }
    );
  }
}
