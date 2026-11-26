import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/auth';
import {
  REPAIR_ACTION,
  StaleCacheAuthError,
  StaleCacheValidationError,
  StaleCacheRepairError,
  buildRegisteredCacheReport,
  createStaleCacheRepairer,
  getMonitoredCache,
} from '@/lib/cache/staleCacheDetector';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/cache/stale
 *
 * Read-only stale-cache report across caches that opted into monitoring.
 * Requires `operations:read`. No cache entry is modified.
 */
export async function GET(request) {
  const authorization = await requirePermission(request, 'operations:read', { allowService: true });
  if (!authorization.ok) {
    return NextResponse.json({ error: 'Forbidden: operations access required' }, { status: authorization.status });
  }

  try {
    const { searchParams } = new URL(request.url);
    const staleGraceMs = searchParams.has('staleGraceMs') ? Number(searchParams.get('staleGraceMs')) : 0;
    const verificationTtlMs = searchParams.has('verificationTtlMs') ? Number(searchParams.get('verificationTtlMs')) : null;

    const report = buildRegisteredCacheReport({
      staleGraceMs,
      verificationTtlMs: Number.isFinite(verificationTtlMs) ? verificationTtlMs : null,
    });

    return NextResponse.json({ ok: true, data: report });
  } catch (error) {
    if (error instanceof StaleCacheValidationError) {
      return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
    }
    console.error('[admin/cache/stale] Failed to build stale-cache report:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/cache/stale
 *
 * Preview or apply a repair recommendation. Requires `operations:write`.
 *
 * Body:
 * {
 *   recommendation: { action, scope, key, risk, rollback, ... },  // from GET
 *   cacheName?: string,
 *   fingerprint?: string,   // optional drift guard from the GET report
 *   dryRun?: boolean,       // default true; false is required to write
 *   reason?: string
 * }
 *
 * Applying a repair invalidates the affected key so the next read is served by
 * the authoritative source. There is no direct "restore stale value" write:
 * the rollback is to leave the key invalidated, which is always safe.
 */
export async function POST(request) {
  const authorization = await requirePermission(request, 'operations:write');
  if (!authorization.ok) {
    return NextResponse.json({ error: 'Forbidden: operations write access required' }, { status: authorization.status });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { recommendation, cacheName, fingerprint, dryRun = true, reason = '' } = body || {};

  if (!recommendation || typeof recommendation !== 'object' || !recommendation.action) {
    return NextResponse.json({ error: 'recommendation is required.' }, { status: 400 });
  }
  if (dryRun === false && typeof reason !== 'string') {
    return NextResponse.json({ error: 'reason must be a string.' }, { status: 400 });
  }

  const principal = {
    id: authorization.user?.sub || authorization.user?.address || authorization.user?.email || 'admin',
    role: authorization.user?.role || 'admin',
  };

  const repairer = createStaleCacheRepairer({
    authorize: async (actor) => {
      const allowedRoles = new Set(['admin', 'operator', 'service', 'superadmin']);
      return Boolean(actor?.id) && allowedRoles.has(actor.role);
    },
    repair: async ({ action, scope, key, attempt }) => {
      const cache = cacheName ? getMonitoredCache(cacheName) : null;
      if (!cache) {
        const error = new Error('The cache for this recommendation is no longer registered.');
        error.retryable = false;
        throw error;
      }
      if (action === REPAIR_ACTION.VERIFY_SOURCE) {
        return { strategy: 'verified', attempt };
      }
      if (typeof cache.invalidate !== 'function') {
        const error = new Error('Registered cache does not support invalidation.');
        error.retryable = false;
        throw error;
      }
      const removed = cache.invalidate(key, { scope });
      return { strategy: 'invalidate', removed, attempt };
    },
  });

  try {
    if (fingerprint) {
      const current = buildRegisteredCacheReport();
      if (current.fingerprint !== fingerprint) {
        return NextResponse.json(
          {
            error: 'Stale-cache findings changed since the report was generated. Re-run the report before repairing.',
            code: 'STALE_CACHE_FINGERPRINT_MISMATCH',
            expected: fingerprint,
            actual: current.fingerprint,
          },
          { status: 409 },
        );
      }
    }

    const result = await repairer.apply({
      recommendation: { ...recommendation, cacheName },
      principal,
      dryRun: dryRun !== false,
      reason,
    });

    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof StaleCacheAuthError || error instanceof StaleCacheValidationError || error instanceof StaleCacheRepairError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error('[admin/cache/stale] Repair failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
