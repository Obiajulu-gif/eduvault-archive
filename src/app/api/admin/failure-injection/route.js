import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/auth';
import {
  FAULT_TYPE,
  INJECTION_STATUS,
  FailureInjectionAuthError,
  FailureInjectionValidationError,
  FailureInjectionBlockedError,
  createFailureInjectionRunner,
} from '@/lib/resilience/failureInjection';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildRunner(authorization) {
  return createFailureInjectionRunner({
    env: process.env,
    requireOptIn: true,
    maxAttempts: 3,
    retryDelayMs: 10,
    sleep,
    authorize: async (principal) => {
      const allowedRoles = new Set(['admin', 'operator', 'service', 'superadmin']);
      return Boolean(principal?.id) && allowedRoles.has(principal.role);
    },
    onEvent: (event) => {
      // Structured, non-sensitive audit trail. Never log the opt-in token.
      console.info('[failure-injection]', JSON.stringify({
        ...event,
        actor: authorization.user?.sub || authorization.user?.address || 'admin',
      }));
    },
  });
}

function principalFor(authorization) {
  return {
    id: authorization.user?.sub || authorization.user?.address || authorization.user?.email || 'admin',
    role: authorization.user?.role || 'admin',
  };
}

/**
 * GET /api/admin/failure-injection
 *
 * Catalog of injectable critical workflows and supported faults. Read-only:
 * requires `operations:read` and never executes a step.
 */
export async function GET(request) {
  const authorization = await requirePermission(request, 'operations:read', { allowService: true });
  if (!authorization.ok) {
    return NextResponse.json({ error: 'Forbidden: operations access required' }, { status: authorization.status });
  }

  const runner = buildRunner(authorization);
  return NextResponse.json({
    ok: true,
    data: {
      workflows: runner.getWorkflows(),
      faultTypes: Object.values(FAULT_TYPE),
      statuses: Object.values(INJECTION_STATUS),
      safety: {
        enabled: process.env.FAILURE_INJECTION_ENABLED === 'true',
        tokenConfigured: Boolean(process.env.FAILURE_INJECTION_TOKEN),
        production: process.env.NODE_ENV === 'production',
      },
      dryRunDefault: true,
    },
  });
}

/**
 * POST /api/admin/failure-injection
 *
 * Run (or plan) an end-to-end fault injection drill. Requires
 * `operations:write`. Dry run is the default; a real run additionally requires
 * FAILURE_INJECTION_ENABLED=true and a valid opt-in token.
 *
 * Body: { workflowId, fault?: { type, step, persistent? }, dryRun?: boolean,
 *         optInToken?: string, allowInProduction?: boolean, reason?: string }
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

  const { workflowId, fault = null, dryRun = true, optInToken, allowInProduction = false, reason = '' } = body || {};

  if (!workflowId) {
    return NextResponse.json({ error: 'workflowId is required.' }, { status: 400 });
  }

  const runner = buildRunner(authorization);

  try {
    const result = await runner.run({
      workflowId,
      fault,
      principal: principalFor(authorization),
      correlationId: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      dryRun: dryRun !== false,
      optInToken,
      allowInProduction: allowInProduction === true,
    });

    return NextResponse.json({ ok: true, data: { ...result, reason: String(reason || '') } });
  } catch (error) {
    if (error instanceof FailureInjectionAuthError || error instanceof FailureInjectionValidationError || error instanceof FailureInjectionBlockedError) {
      return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
    }
    console.error('[admin/failure-injection] Drill failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
