import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/auth';
import { getDb } from '@/lib/mongodb';
import {
  getPartialFailures,
  resolvePartialFailure,
} from '@/lib/backend/partialFailures';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/partial-failures
 *
 * Query parameters:
 *   - domain: 'async_jobs' | 'integrations' | 'user_operations' | 'all'
 *   - status: 'unresolved' | 'resolved' | 'retrying' | 'abandoned'
 *   - severity: 'critical' | 'high' | 'medium' | 'low'
 *   - requiresUserAction: boolean ('true' | 'false')
 *   - limit: number (default 50)
 *   - offset: number (default 0)
 */
export async function GET(request) {
  try {
    const authorization = await requirePermission(request, 'operations:read', { allowService: true });
    if (!authorization.ok) {
      return NextResponse.json({ error: 'Forbidden: operations access required' }, { status: authorization.status });
    }

    const { searchParams } = new URL(request.url);
    const domain = searchParams.get('domain') || undefined;
    const status = searchParams.get('status') || undefined;
    const severity = searchParams.get('severity') || undefined;
    const requiresUserAction = searchParams.get('requiresUserAction') || undefined;
    const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined;
    const offset = searchParams.get('offset') ? Number(searchParams.get('offset')) : undefined;

    const db = await getDb();
    const result = await getPartialFailures(db, {
      domain,
      status,
      severity,
      requiresUserAction,
      limit,
      offset,
    });

    return NextResponse.json({
      ok: true,
      data: result,
    });
  } catch (error) {
    console.error('[admin/partial-failures] Failed to query partial failures:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/admin/partial-failures
 *
 * Resolve or abandon a partial failure.
 * Body: { failureId, resolution: 'resolved' | 'abandoned', note }
 */
export async function PATCH(request) {
  try {
    const authorization = await requirePermission(request, 'operations:write');
    if (!authorization.ok) {
      return NextResponse.json({ error: 'Forbidden: operations write access required' }, { status: authorization.status });
    }

    const body = await request.json();
    const { failureId, resolution, note } = body || {};

    if (!failureId) {
      return NextResponse.json({ error: 'failureId is required' }, { status: 400 });
    }

    const db = await getDb();
    const result = await resolvePartialFailure(db, failureId, {
      actor: authorization.user?.address || authorization.user?.email || 'admin',
      resolution,
      note,
    });

    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    console.error('[admin/partial-failures] Failed to resolve partial failure:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}
