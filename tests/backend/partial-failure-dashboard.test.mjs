/**
 * tests/backend/partial-failure-dashboard.test.mjs
 *
 * Automated verification for the unresolved partial-failure operator dashboard
 * (issue #1101). Covers normal, failure, retry, and authorization paths plus
 * SLA bucketing, unsafe-retry blocking, and audit/rollback behaviour.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DASHBOARD_ACTION,
  AGE_BUCKET,
  DashboardAuthError,
  DashboardValidationError,
  DashboardActionError,
  recommendNextAction,
  enrichFailure,
  buildUnresolvedDashboard,
  createDashboardActions,
} from '../../src/lib/operations/partialFailureDashboard.js';

const NOW = 1_000_000;
const MINUTE = 60_000;

function failure(overrides = {}) {
  return {
    failureId: 'job_1',
    domain: 'async_jobs',
    sourceCollection: 'background_jobs',
    sourceId: '1',
    operation: 'index_material',
    status: 'unresolved',
    severity: 'medium',
    requiresUserAction: false,
    canRetrySafely: true,
    errorCause: { message: 'timeout', code: 'TIMEOUT', retryCount: 0, maxRetries: 3 },
    createdAt: NOW - 2 * MINUTE,
    updatedAt: NOW - 2 * MINUTE,
    ...overrides,
  };
}

// ─── Normal path ──────────────────────────────────────────────────────────

describe('unresolved partial-failure dashboard — normal path (#1101)', () => {
  it('builds an unresolved-only triage view with grouped summary', () => {
    const dashboard = buildUnresolvedDashboard({
      items: [
        failure({ failureId: 'a', severity: 'medium' }),
        failure({ failureId: 'b', severity: 'critical', domain: 'integrations' }),
        failure({ failureId: 'c', status: 'resolved' }),
      ],
    }, { now: () => NOW });

    assert.equal(dashboard.items.length, 2);
    assert.equal(dashboard.summary.total, 2);
    assert.deepEqual(dashboard.items.map((i) => i.failureId), ['b', 'a']); // severity first
    assert.equal(dashboard.summary.byDomain.find((g) => g.key === 'integrations').count, 1);
    assert.equal(dashboard.summary.bySeverity.find((g) => g.key === 'critical').count, 1);
    assert.match(dashboard.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(dashboard.generatedAt, new Date(NOW).toISOString());
  });

  it('accepts a raw array and documents rollback for each next action', () => {
    const dashboard = buildUnresolvedDashboard([failure()], { now: () => NOW });
    assert.equal(dashboard.items.length, 1);
    assert.match(dashboard.items[0].nextAction.rollback, /\S/);
    assert.equal(dashboard.items[0].ageBucket, AGE_BUCKET.FRESH);
  });

  it('can include resolved failures when explicitly requested', () => {
    const dashboard = buildUnresolvedDashboard(
      [failure({ failureId: 'resolved', status: 'resolved' })],
      { now: () => NOW, includeResolved: true },
    );
    assert.equal(dashboard.items.length, 1);
  });

  it('validates its inputs', () => {
    assert.throws(() => buildUnresolvedDashboard(null), DashboardValidationError);
    assert.throws(() => buildUnresolvedDashboard([], { limit: 0 }), DashboardValidationError);
  });
});

// ─── Failure / triage path ────────────────────────────────────────────────

describe('unresolved partial-failure dashboard — failure path (#1101)', () => {
  it('flags SLA breaches and escalates them', () => {
    const stale = failure({ severity: 'critical', createdAt: NOW - 60 * MINUTE });
    const enriched = enrichFailure(stale, { now: () => NOW });

    assert.equal(enriched.ageBucket, AGE_BUCKET.AGING);
    assert.equal(enriched.slaBreached, true);
    assert.equal(enriched.nextAction.type, DASHBOARD_ACTION.ESCALATE);
    assert.match(enriched.nextAction.reason, /SLA/);
  });

  it('routes user-dependent failures to escalation, never auto-retry', () => {
    const item = failure({
      requiresUserAction: true,
      userActionGuidance: 'Ask the buyer to fund their wallet.',
    });
    const enriched = enrichFailure(item, { now: () => NOW });

    assert.equal(enriched.retryAllowed, false);
    assert.equal(enriched.nextAction.type, DASHBOARD_ACTION.ESCALATE);
    assert.equal(enriched.nextAction.reason, 'Ask the buyer to fund their wallet.');
  });

  it('routes non-retryable and exhausted failures to manual resolution', () => {
    const unsafe = failure({ canRetrySafely: false });
    const exhausted = failure({ errorCause: { retryCount: 3, maxRetries: 3 } });

    assert.equal(recommendNextAction(unsafe).type, DASHBOARD_ACTION.RESOLVE);
    assert.equal(recommendNextAction(exhausted).type, DASHBOARD_ACTION.RESOLVE);
  });

  it('reports retryable failures with a safe idempotent retry recommendation', () => {
    const enriched = enrichFailure(failure(), { now: () => NOW });
    assert.equal(enriched.retryAllowed, true);
    assert.equal(enriched.nextAction.type, DASHBOARD_ACTION.RETRY);
  });
});

// ─── Retry / action path ──────────────────────────────────────────────────

describe('unresolved partial-failure dashboard — retry path (#1101)', () => {
  function makeActions(handler, auditCalls = []) {
    return createDashboardActions({
      authorize: async () => true,
      handlers: { [DASHBOARD_ACTION.RETRY]: handler },
      audit: async (record) => { auditCalls.push(record); },
      maxAttempts: 3,
      retryDelayMs: 5,
      sleep: async () => {},
      now: () => NOW,
    });
  }

  it('previews by default without invoking the handler', async () => {
    let calls = 0;
    const auditCalls = [];
    const actions = makeActions(async () => { calls += 1; }, auditCalls);

    const result = await actions.act({
      action: DASHBOARD_ACTION.RETRY,
      failure: failure(),
      failureId: 'job_1',
      principal: { id: 'op-1', role: 'operator' },
      reason: 'drill',
    });

    assert.equal(result.applied, false);
    assert.equal(result.dryRun, true);
    assert.equal(calls, 0);
    assert.equal(auditCalls[0].result, 'PREVIEWED');
    assert.match(result.idempotencyKey, /^[a-f0-9]{64}$/);
  });

  it('retries transient handler failures then applies the action with an audit record', async () => {
    const delays = [];
    const auditCalls = [];
    let calls = 0;
    const actions = createDashboardActions({
      authorize: async () => true,
      handlers: {
        [DASHBOARD_ACTION.RETRY]: async ({ attempt }) => {
          calls += 1;
          if (attempt < 3) throw new Error('temporarily unavailable');
          return { retryQueued: true };
        },
      },
      audit: async (record) => { auditCalls.push(record); },
      retryDelayMs: 10,
      sleep: async (ms) => { delays.push(ms); },
      now: () => NOW,
    });

    const result = await actions.act({
      action: DASHBOARD_ACTION.RETRY,
      failure: failure(),
      failureId: 'job_1',
      principal: { id: 'op-1', role: 'operator' },
      reason: 'incident-42',
      dryRun: false,
    });

    assert.equal(result.applied, true);
    assert.equal(result.attempts, 3);
    assert.deepEqual(delays, [10, 20]);
    assert.deepEqual(result.result, { retryQueued: true });
    assert.equal(auditCalls.at(-1).result, 'APPLIED');
    assert.equal(auditCalls.at(-1).actor, 'op-1');
    assert.equal(auditCalls.at(-1).reason, 'incident-42');
    assert.equal(actions.stats().retries, 2);
  });

  it('does not retry a permanent failure and exposes structured errors', async () => {
    let calls = 0;
    const actions = createDashboardActions({
      authorize: async () => true,
      handlers: {
        [DASHBOARD_ACTION.RETRY]: async () => {
          calls += 1;
          const error = new Error('not found');
          error.retryable = false;
          throw error;
        },
      },
    });

    await assert.rejects(
      () => actions.act({
        action: DASHBOARD_ACTION.RETRY,
        failure: failure(),
        failureId: 'job_1',
        principal: { id: 'op-1' },
        dryRun: false,
      }),
      (error) => error instanceof DashboardActionError && error.attempts === 1 && error.failureId === 'job_1',
    );
    assert.equal(calls, 1);
  });

  it('supports audit-only acknowledge and escalate actions', async () => {
    const auditCalls = [];
    const actions = createDashboardActions({ authorize: async () => true, audit: async (r) => auditCalls.push(r) });
    const result = await actions.act({
      action: DASHBOARD_ACTION.ACKNOWLEDGE,
      failureId: 'job_1',
      principal: { id: 'op-1' },
      dryRun: false,
    });

    assert.equal(result.applied, true);
    assert.equal(result.result.recorded, true);
    assert.equal(auditCalls.length, 1);
  });
});

// ─── Authorization / safety path ──────────────────────────────────────────

describe('unresolved partial-failure dashboard — authorization path (#1101)', () => {
  it('rejects unauthorized actors before any handler or audit runs', async () => {
    let calls = 0;
    let audits = 0;
    const actions = createDashboardActions({
      authorize: async (principal, action) => principal?.role === 'admin' && action === DASHBOARD_ACTION.RESOLVE,
      handlers: { [DASHBOARD_ACTION.RESOLVE]: async () => { calls += 1; } },
      audit: async () => { audits += 1; },
    });

    await assert.rejects(
      () => actions.act({
        action: DASHBOARD_ACTION.RESOLVE,
        failureId: 'job_1',
        principal: { id: 'learner', role: 'learner' },
      }),
      DashboardAuthError,
    );
    assert.equal(calls, 0);
    assert.equal(audits, 0);
    assert.equal(actions.stats().rejected, 1);
  });

  it('blocks retries of user-dependent or unsafe failures even for admins', async () => {
    let calls = 0;
    const actions = createDashboardActions({
      authorize: async () => true,
      handlers: { [DASHBOARD_ACTION.RETRY]: async () => { calls += 1; } },
    });

    for (const target of [
      failure({ requiresUserAction: true }),
      failure({ canRetrySafely: false }),
    ]) {
      await assert.rejects(
        () => actions.act({
          action: DASHBOARD_ACTION.RETRY,
          failure: target,
          failureId: target.failureId,
          principal: { id: 'admin-1', role: 'admin' },
          dryRun: false,
        }),
        (error) => error instanceof DashboardValidationError && /safely retried/.test(error.message),
      );
    }
    assert.equal(calls, 0);
    assert.equal(actions.stats().unsafeBlocked, 2);
  });

  it('validates unknown actions and missing failure ids', async () => {
    const actions = createDashboardActions({ authorize: async () => true });
    await assert.rejects(
      () => actions.act({ action: 'DELETE_ALL', failureId: 'x', principal: { id: 'a' } }),
      DashboardValidationError,
    );
    await assert.rejects(
      () => actions.act({ action: DASHBOARD_ACTION.RETRY, failureId: null, principal: { id: 'a' } }),
      DashboardValidationError,
    );
    assert.throws(() => createDashboardActions({ maxAttempts: 0 }), DashboardValidationError);
  });
});
