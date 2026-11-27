/**
 * Dependency degradation matrix and fallback behavior (#1081).
 * Covers the normal, failure, retry, and authorization paths.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FALLBACK_ACTION, SERVICE_STATE } from '../../src/lib/fallback.js';
import {
  MAX_OVERRIDE_MS,
  applyOperatorOverride,
  buildDegradationMatrix,
  decideOperation,
  deriveServiceStates,
  runWithFallback,
} from '../../src/lib/degradation/dependencyFallbackPlanner.js';

const NOW = new Date('2026-11-18T12:00:00Z');
const ADMIN = { id: 'admin-1', role: 'admin' };
const noSleep = async () => {};

function report(statuses = {}) {
  const base = { database: 'healthy', storage: 'healthy', stellar: 'healthy', email: 'healthy', contracts: 'healthy' };
  const merged = { ...base, ...statuses };
  return { dependencies: Object.fromEntries(Object.entries(merged).map(([name, status]) => [name, { name, status }])) };
}

const row = (matrix, service) => matrix.find((r) => r.service === service);
const op = (matrix, service, operation) => row(matrix, service).operations.find((o) => o.operation === operation);

describe('normal path', () => {
  test('a healthy report allows every operation and nothing is retryable', () => {
    const matrix = buildDegradationMatrix(report());
    assert.deepEqual(matrix.map((r) => r.service), ['stellar', 'mongodb', 'pinata', 'email', 'webhooks']);
    for (const r of matrix) {
      for (const o of r.operations) {
        assert.equal(o.action, FALLBACK_ACTION.ALLOW, `${r.service}.${o.operation}`);
        assert.equal(o.retryable, false);
      }
    }
  });

  test('critical actions without explicit operation config still get a row', () => {
    const matrix = buildDegradationMatrix(report());
    assert.ok(op(matrix, 'mongodb', 'settle_refund'), 'settle_refund comes from criticalActions');
  });

  test('services without a health check are marked unobserved', () => {
    const states = deriveServiceStates(report());
    assert.equal(states.webhooks.observed, false);
    assert.equal(states.mongodb.observed, true);
    assert.deepEqual(states.stellar.sources.sort(), ['contracts', 'stellar']);
  });
});

describe('failure paths', () => {
  test('an unavailable database blocks critical writes and is retryable', () => {
    const matrix = buildDegradationMatrix(report({ database: 'unavailable' }));
    const write = op(matrix, 'mongodb', 'write_purchase');
    assert.equal(write.action, FALLBACK_ACTION.BLOCK);
    assert.equal(write.critical, true);
    assert.equal(write.retryable, true);
    assert.ok(write.retryAfterSeconds > 0);
  });

  test('the worst state wins when two checks feed one service', () => {
    const states = deriveServiceStates(report({ stellar: 'degraded', contracts: 'unavailable' }));
    assert.equal(states.stellar.state, SERVICE_STATE.UNAVAILABLE);
    const purchase = op(buildDegradationMatrix(report({ contracts: 'unavailable' })), 'stellar', 'purchase');
    assert.equal(purchase.action, FALLBACK_ACTION.BLOCK);
  });

  test('misconfigured fails closed but tells clients not to retry', () => {
    const matrix = buildDegradationMatrix(report({ storage: 'misconfigured' }));
    assert.equal(row(matrix, 'pinata').state, SERVICE_STATE.UNAVAILABLE);
    const upload = op(matrix, 'pinata', 'upload_material');
    assert.notEqual(upload.action, FALLBACK_ACTION.ALLOW);
    assert.equal(upload.retryable, false);
    assert.equal(upload.retryAfterSeconds, null);
    assert.equal(upload.reason, 'misconfigured');
  });

  test('unknown statuses and services fail closed', () => {
    assert.equal(deriveServiceStates(report({ email: 'weird' })).email.state, SERVICE_STATE.UNAVAILABLE);
    assert.equal(decideOperation('nope', 'x').action, FALLBACK_ACTION.BLOCK);
  });

  test('a degraded email service queues receipts instead of failing purchases', () => {
    const matrix = buildDegradationMatrix(report({ email: 'degraded' }));
    assert.equal(op(matrix, 'stellar', 'purchase').action, FALLBACK_ACTION.ALLOW);
    assert.notEqual(op(matrix, 'email', 'send_receipt').action, FALLBACK_ACTION.BLOCK);
  });
});

describe('retry path (runWithFallback)', () => {
  const degradedDecision = () => decideOperation('pinata', 'download_content', { state: SERVICE_STATE.DEGRADED });

  test('retries a retryable decision with backoff and recovers', async () => {
    const decision = degradedDecision();
    assert.equal(decision.retryable, true);
    let calls = 0;
    const delays = [];
    const result = await runWithFallback(
      decision,
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('gateway timeout');
        return 'bytes';
      },
      { attempts: 3, baseDelayMs: 10, sleep: async (ms) => delays.push(ms) }
    );
    assert.equal(result.ok, true);
    assert.equal(result.result, 'bytes');
    assert.equal(result.attempts, 3);
    assert.deepEqual(delays, [10, 20]);
  });

  test('exhausted retries return a user-safe body without the raw error', async () => {
    const result = await runWithFallback(
      degradedDecision(),
      async () => {
        throw new Error('connect to mongodb://root:hunter2@10.0.0.5 failed');
      },
      { attempts: 2, sleep: noSleep }
    );
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.ok(result.userMessage);
    assert.ok(!JSON.stringify(result).includes('hunter2'));
  });

  test('a healthy decision runs once and never retries', async () => {
    let calls = 0;
    const decision = decideOperation('pinata', 'download_content', { state: SERVICE_STATE.HEALTHY });
    const result = await runWithFallback(decision, async () => { calls += 1; throw new Error('x'); }, { attempts: 5, sleep: noSleep });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
  });

  test('blocked operations never call the handler; queued ones call onQueue', async () => {
    let called = false;
    const blocked = await runWithFallback(
      decideOperation('mongodb', 'write_purchase', { state: SERVICE_STATE.UNAVAILABLE }),
      async () => { called = true; }
    );
    assert.equal(called, false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'SERVICE_UNAVAILABLE');

    let queued = false;
    const queue = decideOperation('stellar', 'payout', { state: SERVICE_STATE.DEGRADED });
    assert.equal(queue.action, FALLBACK_ACTION.QUEUE);
    const result = await runWithFallback(queue, async () => { called = true; }, { onQueue: async () => { queued = true; } });
    assert.equal(queued, true);
    assert.equal(called, false);
    assert.equal(result.queued, true);
  });
});

describe('authorization path (applyOperatorOverride)', () => {
  const expiresAt = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
  const queuedEmail = () => decideOperation('email', 'send_receipt', { state: SERVICE_STATE.UNAVAILABLE });

  test('no override leaves the decision unchanged', () => {
    const decision = queuedEmail();
    const result = applyOperatorOverride(decision, { actor: ADMIN });
    assert.equal(result.applied, false);
    assert.equal(result.error, null);
    assert.equal(result.decision, decision);
  });

  test('non-admins cannot override', () => {
    for (const actor of [null, { id: 'c', role: 'creator' }, { id: 's', role: 'service' }]) {
      const result = applyOperatorOverride(queuedEmail(), {
        actor,
        override: { action: FALLBACK_ACTION.ALLOW, reason: 'drain backlog now', expiresAt },
        now: NOW,
      });
      assert.equal(result.applied, false);
      assert.match(result.error, /forbidden/);
    }
  });

  test('an admin can relax a non-critical decision with a reason and expiry, and it is audited', () => {
    const result = applyOperatorOverride(queuedEmail(), {
      actor: ADMIN,
      override: { action: FALLBACK_ACTION.ALLOW, reason: 'SMTP relay restored, draining backlog', expiresAt },
      now: NOW,
    });
    assert.equal(result.applied, true, result.error);
    assert.equal(result.decision.action, FALLBACK_ACTION.ALLOW);
    assert.equal(result.audit.actor, 'admin-1');
    assert.equal(result.audit.to, FALLBACK_ACTION.ALLOW);
    assert.equal(result.audit.expiresAt, expiresAt);
  });

  test('blocked critical operations and unavailable tier 1 services cannot be relaxed', () => {
    const override = { action: FALLBACK_ACTION.ALLOW, reason: 'business wants sales back on', expiresAt };
    const purchase = decideOperation('stellar', 'purchase', { state: SERVICE_STATE.UNAVAILABLE });
    assert.match(applyOperatorOverride(purchase, { actor: ADMIN, override, now: NOW }).error, /cannot be relaxed/);
    const catalog = decideOperation('mongodb', 'read_catalog', { state: SERVICE_STATE.UNAVAILABLE });
    assert.match(applyOperatorOverride(catalog, { actor: ADMIN, override, now: NOW }).error, /tier 1/);
  });

  test('an admin can always tighten to block as a kill switch', () => {
    const purchase = decideOperation('stellar', 'purchase', { state: SERVICE_STATE.HEALTHY });
    const result = applyOperatorOverride(purchase, {
      actor: ADMIN,
      override: { action: FALLBACK_ACTION.BLOCK, reason: 'incident 42: suspected double charge', expiresAt },
      now: NOW,
    });
    assert.equal(result.applied, true);
    assert.equal(result.decision.action, FALLBACK_ACTION.BLOCK);
    assert.equal(result.decision.retryable, false);
  });

  test('missing reason, invalid action, expired or too-long overrides are refused', () => {
    const attempt = (override) => applyOperatorOverride(queuedEmail(), { actor: ADMIN, override, now: NOW }).error;
    assert.match(attempt({ action: 'allow', reason: 'short', expiresAt }), /reason/);
    assert.match(attempt({ action: 'yolo', reason: 'a valid long reason', expiresAt }), /invalid override action/);
    assert.match(attempt({ action: 'allow', reason: 'a valid long reason', expiresAt: '2026-11-18T11:00:00Z' }), /expired/);
    const tooLong = new Date(NOW.getTime() + MAX_OVERRIDE_MS + 1000).toISOString();
    assert.match(attempt({ action: 'allow', reason: 'a valid long reason', expiresAt: tooLong }), /at most 4 hours/);
  });
});
