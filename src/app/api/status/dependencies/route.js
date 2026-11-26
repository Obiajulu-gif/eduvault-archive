import { NextResponse } from 'next/server';
import { checkAllDependencies } from '@/lib/health/dependencyChecker';
import {
  USER_STATUS,
  assertSafeForUsers,
  buildUserFacingStatus,
} from '@/lib/status/degradedDependencyStatus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/status/dependencies
 *
 * Public, user-facing status of feature areas affected by degraded
 * dependencies. Only feature-level impact is exposed: dependency names,
 * hostnames, latencies, remediation notes, and raw errors are never published.
 *
 * This endpoint is additive — `GET /api/status` keeps its existing contract.
 */
export async function GET() {
  let payload;
  try {
    const report = await checkAllDependencies({ env: process.env });
    payload = buildUserFacingStatus({ dependencyReport: report });
  } catch {
    // A failing health probe is a degraded signal, not an error to echo.
    payload = buildUserFacingStatus({ dependencyReport: null });
    payload.status = USER_STATUS.DEGRADED;
    payload.banner = 'We are currently checking our services. Some features may be temporarily limited.';
    payload.suggestedStatus = 503;
  }

  if (!assertSafeForUsers(payload)) {
    payload = buildUserFacingStatus({ dependencyReport: null });
    payload.status = USER_STATUS.DEGRADED;
    payload.suggestedStatus = 503;
  }

  return NextResponse.json(payload, {
    status: payload.suggestedStatus,
    headers: {
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      'X-EduVault-User-Status': payload.status,
    },
  });
}
