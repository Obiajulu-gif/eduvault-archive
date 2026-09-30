import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/auth';
import { getDb } from '@/lib/mongodb';
import { getOperationalHealth } from '@/lib/backend/operationalHealth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/health-dashboard
 *
 * Operational health and unresolved exceptions report endpoint.
 * Protected by an admin session or the least-privilege operations service token.
 *
 * Query parameters:
 *   - category: optional filter to a single health category
 *   -includeResolved: optional boolean (default false) to include resolved records
 *   -includeDetails: optional boolean (default false) to include redacted evidence
 */
export async function GET(request) {
  try {
    const authorization = await requirePermission(request, 'operations:read', { allowService: true });
    if (!authorization.ok) {
      return NextResponse.json({ error: 'Forbidden: operations access required' }, { status: authorization.status });
    }

    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category') || undefined;
    const includeResolved = searchParams.get('includeResolved') === 'true';
    const includeDetails = searchParams.get('includeDetails') === 'true';

    const db = await getDb();
    const health = await getOperationalHealth(db, {
      category,
      includeResolved,
      includeDetails,
    });

    return NextResponse.json({
      ok: true,
      data: health,
    });
  } catch (error) {
    console.error('[admin/health-dashboard] Failed to generate operational health report:', error);
    return NextResponse.json(
      { error: 'Internal Server Error', message: error.message },
      { status: 500 }
    );
  }
}
