import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/auth';
import { getDb } from '@/lib/mongodb';
import {
  getPartialFailures,
  resolvePartialFailure,
  retryPartialFailure,
} from '@/lib/backend/partialFailures';
import { appendAuditRecord } from '@/lib/backend/auditLedger';
import {
  DASHBOARD_ACTION,
  DashboardAuthError,
  DashboardValidationError,
  DashboardActionError,
  buildUnresolvedDashboard,
  createDashboardActions,
} from '@/lib/operations/partialFailureDashboard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/partial-failures/triage
 *
 * Unresolved-only operator triage view: age buckets, SLA breaches, grouped
 * queues, and a recommended next action per failure. Read-only.
 */
export async function GET(request) {
  const authorization = await requirePermission(request, 'operations:read', { allowService: true });
  if (!authorization.ok) {
    return NextResponse.json({ error: 'Forbidden: operations access required' }, { status: authorization.status });
  }

  try {
    const { searchParams } = new URL(request.url);
    const db = await getDb();
    const result = await getPartialFailures(db, {
      status: 'unresolved',
      domain: searchParams.get('domain') || undefined,
      severity: searchParams.get('severity') || undefined,
      limit: 200,
      offset: 0,
    });
    const dashboard = buildUnresolvedDashboard(result, {
      includeResolved: searchParams.get('includeResolved') === 'true',
      limit: searchParams.has('limit') ? Number(searchParams.get('limit')) : 200,
    });

    return NextResponse.json({ ok: true, data: dashboard });
  } catch (error) {
    if (error instanceof DashboardValidationError) {
      return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: 400 });
    }
    console.error('[admin/partial-failures/triage] Failed to build triage view:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/partial-failures/triage
 *
 * Apply an operator action from the triage view. Requires `operations:write`.
 * `dryRun` defaults to true (plan only). Every applied action is written to the
 * signed audit ledger with the actor, reason, and idempotency key.
 *
 * Body: { action: 'ACKNOWLEDGE'|'RETRY'|'RESOLVE'|'ESCALATE',
 *         failureId, reason?, dryRun? }
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

  const { action, failureId, reason = '', dryRun = true } = body || {};
  const actor = authorization.user?.sub || authorization.user?.address || authorization.user?.email || 'admin';

  if (!Object.values(DASHBOARD_ACTION).includes(action)) {
    return NextResponse.json(
      { error: `Unknown action "${action}".`, validActions: Object.values(DASHBOARD_ACTION) },
      { status: 400 },
    );
  }
  if (!failureId) {
    return NextResponse.json({ error: 'failureId is required.' }, { status: 400 });
  }

  try {
    const db = await getDb();

    // Fetch the target record so safety checks use live failure metadata rather
    // than trusting client-supplied flags.
    const all = await getPartialFailures(db, { status: 'all', limit: 200, offset: 0 });
    const failure = all.items?.find((item) => item.failureId === failureId) ?? null;
    if (!failure) {
      return NextResponse.json({ error: `Partial failure "${failureId}" was not found.` }, { status: 404 });
    }

    const actions = createDashboardActions({
      authorize: async (principal, candidateAction) => {
        if (!principal?.id) return false;
        const role = principal.role;
        if (candidateAction === DASHBOARD_ACTION.ACKNOWLEDGE || candidateAction === DASHBOARD_ACTION.ESCALATE) {
          return ['admin', 'superadmin', 'operator', 'service'].includes(role);
        }
        return ['admin', 'superadmin', 'operator'].includes(role);
      },
      handlers: {
        [DASHBOARD_ACTION.RETRY]: (input) => retryPartialFailure(db, failureId, {
          actor,
          reason: input.reason || 'Operator retry from unresolved-failures triage dashboard',
        }),
        [DASHBOARD_ACTION.RESOLVE]: (input) => resolvePartialFailure(db, failureId, {
          actor,
          resolution: 'resolved',
          note: input.reason || 'Resolved from unresolved-failures triage dashboard',
        }),
      },
      audit: async (record) => {
        await appendAuditRecord({
          db,
          operationId: `partial-failure-triage:${record.idempotencyKey}`,
          actor: record.actor,
          actorContext: { source: 'unresolved-failures-dashboard' },
          action: `PARTIAL_FAILURE_${record.action}`,
          target: { collection: 'partial_failures', id: record.failureId },
          result: { status: record.result, attempts: record.attempts ?? 0 },
          reason: record.reason || null,
          intent: { action: record.action, failureId: record.failureId },
        });
      },
    });

    const result = await actions.act({
      action,
      failure,
      failureId,
      principal: { id: actor, role: authorization.user?.role || 'admin' },
      reason,
      dryRun: dryRun !== false,
    });

    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof DashboardAuthError || error instanceof DashboardValidationError || error instanceof DashboardActionError) {
      return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
    }
    console.error('[admin/partial-failures/triage] Action failed:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
