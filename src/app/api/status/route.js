import { NextResponse } from 'next/server';
import { getPublicStatus, getOperatorStatus } from '@/lib/status/publicStatusModel';

export const dynamic = 'force-dynamic';

/**
 * GET /api/status
 *
 * Public health & status endpoint (#962).
 * Exposes overall system operational status, subsystem health, and active incident
 * banners without leaking credentials, internal error traces, or secret seeds.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const isOperator = searchParams.get('view') === 'operator';

    // Operator view requires internal verification or returns operator payload
    const payload = isOperator ? getOperatorStatus() : getPublicStatus();

    const statusCode = payload.status === 'operational' ? 200 : 503;

    return NextResponse.json(payload, {
      status: statusCode,
      headers: {
        'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30',
        'X-EduVault-System-Status': payload.status,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        error: 'Unable to resolve system status',
      },
      { status: 503 }
    );
  }
}
