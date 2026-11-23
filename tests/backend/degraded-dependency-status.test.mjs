/**
 * tests/backend/degraded-dependency-status.test.mjs
 *
 * Automated verification for user-facing status of degraded dependencies
 * (issue #1099). Covers normal, failure, retry, and authorization paths plus
 * zero-leakage and override safety invariants.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEPENDENCY_STATUS } from '../../src/lib/health/dependencyChecker.js';
import { SYSTEM_STATE } from '../../src/lib/status/publicStatusModel.js';
import {
  USER_STATUS,
  StatusAuthError,
  StatusValidationError,
  buildUserFacingStatus,
  assertSafeForUsers,
  createUserFacingStatusStore,
} from '../../src/lib/status/degradedDependencyStatus.js';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

function dep(status, critical = false) {
  return {
    status,
    critical,
    message: 'mongodb://admin:secret@db.internal:27017 ECONNREFUSED at /src/internal/foo.js:12',
    remediation: 'Rotate PINATA_JWT=abc123 and restart the cluster',
    latencyMs: 9999,
  };
}

function report(overrides = {}) {
  const healthy = {
    database: dep(DEPENDENCY_STATUS.HEALTHY, true),
    stellar: dep(DEPENDENCY_STATUS.HEALTHY, true),
    storage: dep(DEPENDENCY_STATUS.HEALTHY),
    email: dep(DEPENDENCY_STATUS.HEALTHY),
    contracts: dep(DEPENDENCY_STATUS.HEALTHY),
  };
  return { status: DEPENDENCY_STATUS.HEALTHY, dependencies: { ...healthy, ...overrides } };
}

// ─── Normal path ──────────────────────────────────────────────────────────

describe('user-facing dependency status — normal path (#1099)', () => {
  it('reports operational status when every dependency is healthy', () => {
    const payload = buildUserFacingStatus({ dependencyReport: report(), now: () => NOW });

    assert.equal(payload.status, USER_STATUS.OPERATIONAL);
    assert.equal(payload.banner, null);
    assert.deepEqual(payload.affectedAreas, []);
    assert.equal(payload.retryAfterSeconds, 0);
    assert.equal(payload.canRetry, true);
    assert.equal(payload.suggestedStatus, 200);
    assert.equal(payload.features.length > 0, true);
    assert.equal(assertSafeForUsers(payload), true);
  });

  it('uses deterministic timestamps from the injected clock', () => {
    const payload = buildUserFacingStatus({ dependencyReport: report(), now: NOW });
    assert.equal(payload.updatedAt, new Date(NOW).toISOString());
  });

  it('publishes feature-level labels, never internal dependency names', () => {
    const json = JSON.stringify(buildUserFacingStatus({ dependencyReport: report(), now: () => NOW }));
    for (const internal of ['database', 'stellar', 'pinata', 'mongodb://', 'ECONNREFUSED', 'latencyMs']) {
      assert.equal(json.includes(internal), false, `must not expose ${internal}`);
    }
    assert.match(json, /payments-and-licensing/);
  });
});

// ─── Failure path ─────────────────────────────────────────────────────────

describe('user-facing dependency status — failure path (#1099)', () => {
  it('reports degraded when a dependency is slow', () => {
    const payload = buildUserFacingStatus({
      dependencyReport: report({ storage: dep(DEPENDENCY_STATUS.DEGRADED) }),
      now: () => NOW,
    });

    assert.equal(payload.status, USER_STATUS.DEGRADED);
    assert.match(payload.banner, /slower|monitor/i);
    assert.equal(payload.affectedAreas.length > 0, true);
    assert.equal(payload.suggestedStatus, 200);
  });

  it('reports partial outage for a non-critical dependency failure', () => {
    const payload = buildUserFacingStatus({
      dependencyReport: report({ email: dep(DEPENDENCY_STATUS.UNAVAILABLE) }),
      now: () => NOW,
    });

    assert.equal(payload.status, USER_STATUS.PARTIAL_OUTAGE);
    assert.equal(payload.suggestedStatus, 503);
    assert.ok(payload.affectedAreas.includes('receipts'));
    assert.equal(assertSafeForUsers(payload), true);
  });

  it('reports unavailable for a critical dependency failure', () => {
    const payload = buildUserFacingStatus({
      dependencyReport: report({ stellar: dep(DEPENDENCY_STATUS.UNAVAILABLE, true) }),
      now: () => NOW,
    });

    assert.equal(payload.status, USER_STATUS.UNAVAILABLE);
    assert.equal(payload.canRetry, true);
    assert.equal(payload.suggestedStatus, 503);
  });

  it('treats misconfiguration as an outage without leaking remediation', () => {
    const payload = buildUserFacingStatus({
      dependencyReport: report({ database: dep(DEPENDENCY_STATUS.MISCONFIGURED, true) }),
      now: () => NOW,
    });

    assert.equal(payload.status, USER_STATUS.UNAVAILABLE);
    assert.equal(JSON.stringify(payload).includes('PINATA_JWT'), false);
  });

  it('honours subsystem maintenance and paused states', () => {
    const maintenance = buildUserFacingStatus({
      dependencyReport: report(),
      subsystemState: { state: SYSTEM_STATE.MAINTENANCE },
      now: () => NOW,
    });
    const paused = buildUserFacingStatus({
      dependencyReport: report(),
      subsystemState: { state: SYSTEM_STATE.PAUSED },
      now: () => NOW,
    });

    assert.equal(maintenance.status, USER_STATUS.MAINTENANCE);
    assert.equal(maintenance.canRetry, false);
    assert.equal(maintenance.retryAfterSeconds, 0);
    assert.equal(paused.status, USER_STATUS.PARTIAL_OUTAGE);
  });

  it('falls back to a safe degraded payload when no report is available', () => {
    const payload = buildUserFacingStatus({ dependencyReport: null, now: () => NOW });
    assert.equal(payload.status, USER_STATUS.DEGRADED);
    assert.equal(assertSafeForUsers(payload), true);
  });
});

// ─── Retry path ───────────────────────────────────────────────────────────

describe('user-facing dependency status — retry path (#1099)', () => {
  it('publishes the longest retry-after among affected features', () => {
    const payload = buildUserFacingStatus({
      dependencyReport: report({
        stellar: dep(DEPENDENCY_STATUS.DEGRADED, true),
        email: dep(DEPENDENCY_STATUS.DEGRADED),
      }),
      now: () => NOW,
    });

    assert.equal(payload.retryAfterSeconds, 300);
    assert.equal(payload.canRetry, true);
  });

  it('does not ask users to retry during maintenance', () => {
    const payload = buildUserFacingStatus({
      dependencyReport: report(),
      subsystemState: { state: SYSTEM_STATE.MAINTENANCE },
      now: () => NOW,
    });
    assert.equal(payload.canRetry, false);
  });

  it('status store survives a throwing health provider', async () => {
    const store = createUserFacingStatusStore({
      dependenciesProvider: async () => { throw new Error('db connection refused at /internal'); },
      now: () => NOW,
    });

    const payload = await store.get();
    assert.equal(payload.status, USER_STATUS.DEGRADED);
    assert.equal(assertSafeForUsers(payload), true);
  });
});

// ─── Authorization path ───────────────────────────────────────────────────

describe('user-facing dependency status — authorization path (#1099)', () => {
  function makeStore() {
    return createUserFacingStatusStore({
      dependenciesProvider: async () => report(),
      authorize: async (principal, action) => principal?.role === 'admin' && action === 'status:override',
      now: () => NOW,
    });
  }

  it('rejects anonymous and non-admin overrides', async () => {
    const store = makeStore();
    await assert.rejects(
      () => store.setOverride({ dependency: 'stellar', status: USER_STATUS.DEGRADED, principal: null }),
      StatusAuthError,
    );
    await assert.rejects(
      () => store.setOverride({ dependency: 'stellar', status: USER_STATUS.DEGRADED, principal: { id: 'u', role: 'learner' } }),
      StatusAuthError,
    );
    assert.deepEqual(store.getOperatorView().overrides, {});
  });

  it('allows an authorized operator to escalate status with sanitized text', async () => {
    const store = makeStore();
    const payload = await store.setOverride({
      dependency: 'stellar',
      status: USER_STATUS.PARTIAL_OUTAGE,
      message: 'mongodb://secret@db.internal payments delayed',
      principal: { id: 'admin-1', role: 'admin' },
    });

    assert.equal(payload.status, USER_STATUS.PARTIAL_OUTAGE);
    assert.equal(payload.features.every((f) => !JSON.stringify(f).includes('db.internal')), true);
    assert.equal(assertSafeForUsers(payload), true);
    assert.equal(store.getOperatorView().overrides.stellar.actor, 'admin-1');
  });

  it('never allows an override to mask an observed outage', async () => {
    const store = createUserFacingStatusStore({
      dependenciesProvider: async () => report({ stellar: dep(DEPENDENCY_STATUS.UNAVAILABLE, true) }),
      authorize: async () => true,
      now: () => NOW,
    });

    await assert.rejects(
      () => store.setOverride({ dependency: 'stellar', status: USER_STATUS.OPERATIONAL, principal: { id: 'a' } }),
      (error) => error instanceof StatusValidationError && /healthier/.test(error.message),
    );
  });

  it('requires the same authorization to clear an override', async () => {
    const store = makeStore();
    await store.setOverride({
      dependency: 'email',
      status: USER_STATUS.DEGRADED,
      principal: { id: 'admin-1', role: 'admin' },
    });
    await assert.rejects(
      () => store.clearOverride({ dependency: 'email', principal: { id: 'u', role: 'learner' } }),
      StatusAuthError,
    );
    const cleared = await store.clearOverride({ dependency: 'email', principal: { id: 'admin-1', role: 'admin' } });
    assert.equal(cleared.status, USER_STATUS.OPERATIONAL);
    assert.deepEqual(store.getOperatorView().overrides, {});
  });

  it('validates dependency and status inputs', async () => {
    const store = createUserFacingStatusStore({ dependenciesProvider: async () => report(), authorize: async () => true });
    await assert.rejects(
      () => store.setOverride({ dependency: 'unknown', status: USER_STATUS.DEGRADED, principal: { id: 'a' } }),
      StatusValidationError,
    );
    await assert.rejects(
      () => store.setOverride({ dependency: 'stellar', status: 'made-up', principal: { id: 'a' } }),
      StatusValidationError,
    );
    assert.throws(() => createUserFacingStatusStore({}), StatusValidationError);
  });
});
