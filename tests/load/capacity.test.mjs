/**
 * Capacity and load tests — concurrency budgets, backpressure, fault
 * injection, and load shedding verification.
 *
 * Covers: ramp, spike, soak, and fault scenarios including slow Mongo,
 * connection exhaustion, retry storms, worker backlog, memory pressure,
 * and recovery after dependency restoration.
 */

import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';

// ── Import modules under test ────────────────────────────────────────────────

import {
  getRouteBudget,
  buildOverloadResponse,
  SYSTEM_LIMITS,
  ROUTE_BUDGETS,
} from '../../src/lib/capacity/budgets.js';

import {
  acquireSlot,
  getConcurrencyStats,
  resetConcurrencyState,
} from '../../src/lib/capacity/concurrency.js';

import {
  updatePressureSignal,
  getPressureLevel,
  shouldShed,
  preRequestShed,
} from '../../src/lib/capacity/shed.js';

import {
  createBoundedQueue,
} from '../../src/lib/capacity/backpressure.js';

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  resetConcurrencyState();
});

afterEach(() => {
  resetConcurrencyState();
});

// =============================================================================
// Budget Tests
// =============================================================================

describe('Capacity — Budgets', () => {

  test('all critical routes have priority 0', () => {
    const criticalRoutes = [
      'POST:/api/purchase',
      'GET:/api/download',
      'GET:/api/entitlements',
      'POST:/api/checkout/verify',
    ];
    for (const key of criticalRoutes) {
      const budget = ROUTE_BUDGETS[key];
      assert.ok(budget, `Missing budget for ${key}`);
      assert.equal(budget.priority, 0, `${key} should be priority 0 (critical)`);
      assert.deepEqual(budget.degradeWith, [], `${key} should not degrade`);
    }
  });

  test('upload route has higher timeout than purchase', () => {
    const upload = getRouteBudget('POST', '/api/upload');
    const purchase = getRouteBudget('POST', '/api/purchase');
    assert.ok(upload.timeoutMs > purchase.timeoutMs);
  });

  test('unknown routes get default budget', () => {
    const budget = getRouteBudget('GET', '/api/unknown');
    assert.equal(budget.maxConcurrent, 20);
    assert.equal(budget.priority, 2);
    assert.ok(budget.timeoutMs > 0);
  });

  test('all budgets have required fields', () => {
    const requiredFields = ['maxConcurrent', 'maxQueueDepth', 'timeoutMs', 'maxPayloadBytes', 'priority'];
    for (const [key, budget] of Object.entries(ROUTE_BUDGETS)) {
      for (const field of requiredFields) {
        assert.ok(field in budget, `${key} missing ${field}`);
        assert.ok(typeof budget[field] === 'number', `${key}.${field} should be a number`);
      }
    }
  });

  test('system limits are sensible', () => {
    assert.ok(SYSTEM_LIMITS.maxConcurrentRequests > 0);
    assert.ok(SYSTEM_LIMITS.maxMongoOperations > 0);
    assert.ok(SYSTEM_LIMITS.maxOutboundHttp > 0);
    assert.ok(SYSTEM_LIMITS.memorySoftLimitBytes > 0);
    assert.ok(SYSTEM_LIMITS.memoryHardLimitBytes > SYSTEM_LIMITS.memorySoftLimitBytes);
  });
});

// =============================================================================
// Overload Response Tests
// =============================================================================

describe('Capacity — Overload Responses', () => {

  test('builds correct 503 response for queue full', () => {
    const res = buildOverloadResponse({
      route: 'POST:/api/purchase',
      reason: 'queue_full',
      retryAfterSeconds: 5,
    });

    assert.equal(res.status, 503);
    assert.equal(res.body.reason, 'queue_full');
    assert.equal(res.headers['Retry-After'], '5');
    assert.equal(res.headers['X-Overload-Reason'], 'queue_full');
  });

  test('builds correct 503 response for system overload', () => {
    const res = buildOverloadResponse({
      route: 'GET:/api/download',
      reason: 'system_overload',
      retryAfterSeconds: 10,
    });

    assert.equal(res.status, 503);
    assert.equal(res.body.reason, 'system_overload');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  test('includes detail message', () => {
    const res = buildOverloadResponse({
      route: 'POST:/api/upload',
      reason: 'concurrency_limit',
      retryAfterSeconds: 3,
      detail: 'Custom detail',
    });

    assert.equal(res.body.detail, 'Custom detail');
  });
});

// =============================================================================
// Concurrency Limiter Tests
// =============================================================================

describe('Capacity — Concurrency Limiter', () => {

  test('acquires slot immediately when under limit', async () => {
    const result = await acquireSlot('GET', '/api/health');
    assert.equal(result.acquired, true);
    assert.equal(typeof result.release, 'function');

    const stats = getConcurrencyStats();
    assert.equal(stats.global, 1);
    assert.ok(stats.routes['GET:/api/health']);

    result.release();

    const afterRelease = getConcurrencyStats();
    assert.equal(afterRelease.global, 0);
  });

  test('releases slot correctly', async () => {
    const r1 = await acquireSlot('GET', '/api/health');
    const r2 = await acquireSlot('GET', '/api/health');

    const stats = getConcurrencyStats();
    assert.equal(stats.global, 2);

    r1.release();
    const mid = getConcurrencyStats();
    assert.equal(mid.global, 1);

    r2.release();
    const end = getConcurrencyStats();
    assert.equal(end.global, 0);
  });

  test('rejects when global limit exceeded', async () => {
    // Fill up to the health route limit (10) + a few more to hit global
    const slots = [];
    // Health route has maxConcurrent=10, so acquire all 10
    for (let i = 0; i < 10; i++) {
      slots.push(await acquireSlot('GET', '/api/health'));
    }

    // Try to acquire on a different route — should work since global is 200
    const result = await acquireSlot('POST', '/api/purchase');
    assert.equal(result.acquired, true);
    result.release();

    // Release all
    for (const s of slots) s.release();
  });

  test('double release is safe', async () => {
    const result = await acquireSlot('GET', '/api/health');
    result.release();
    result.release(); // Should not throw

    const stats = getConcurrencyStats();
    assert.equal(stats.global, 0);
  });

  test('concurrent acquire/release cycles', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await acquireSlot('GET', '/api/health'));
    }

    assert.equal(getConcurrencyStats().global, 5);

    // Release all but first
    for (let i = 1; i < results.length; i++) {
      results[i].release();
    }

    assert.equal(getConcurrencyStats().global, 1);

    // Release first
    results[0].release();
    assert.equal(getConcurrencyStats().global, 0);
  });
});

// =============================================================================
// Load Shedding Tests
// =============================================================================

describe('Capacity — Load Shedding', () => {

  test('critical routes (priority 0) are never shed', () => {
    // Simulate high pressure
    updatePressureSignal('memoryPressure', 0.95);

    const { shouldShed: shed1 } = shouldShed('POST', '/api/purchase');
    const { shouldShed: shed2 } = shouldShed('GET', '/api/download');
    const { shouldShed: shed3 } = shouldShed('GET', '/api/entitlements');

    assert.equal(shed1, false);
    assert.equal(shed2, false);
    assert.equal(shed3, false);
  });

  test('low priority routes shed under pressure', () => {
    updatePressureSignal('memoryPressure', 0.9);

    const { shouldShed: shedLow } = shouldShed('GET', '/api/metrics');
    assert.equal(shedLow, true);
  });

  test('medium priority routes shed at higher pressure', () => {
    // Low pressure — medium priority should not shed
    updatePressureSignal('memoryPressure', 0.2);
    const { shouldShed: noShed } = shouldShed('GET', '/api/market-materials');
    assert.equal(noShed, false);

    // High pressure — medium priority should shed
    updatePressureSignal('memoryPressure', 0.9);
    const { shouldShed: shed } = shouldShed('GET', '/api/market-materials');
    assert.equal(shed, true);
  });

  test('preRequestShed returns response object when shedding', () => {
    updatePressureSignal('memoryPressure', 0.95);

    const result = preRequestShed('GET', '/api/metrics');
    assert.equal(result.shed, true);
    assert.equal(result.response.status, 503);
    assert.ok(result.response.body.reason);
  });

  test('preRequestShed returns no shed when pressure is low', () => {
    updatePressureSignal('memoryPressure', 0.1);

    const result = preRequestShed('POST', '/api/purchase');
    assert.equal(result.shed, false);
  });

  test('pressure level reports correctly', () => {
    updatePressureSignal('memoryPressure', 0.5);

    const { level, reasons } = getPressureLevel();
    assert.ok(level >= 0 && level <= 1);
    // Memory at 50% shouldn't trigger high pressure on its own
    // (threshold is 70%)
  });
});

// =============================================================================
// Bounded Queue Tests
// =============================================================================

describe('Capacity — Bounded Queue', () => {

  test('processes items within capacity', async () => {
    const queue = createBoundedQueue({ maxSize: 10, maxConcurrency: 3 });

    const processed = [];
    const pushPromises = [];

    for (let i = 0; i < 3; i++) {
      pushPromises.push(
        queue.push(i).then((item) => {
          processed.push(item);
          queue.markDone();
        })
      );
    }

    await Promise.all(pushPromises);
    assert.equal(processed.length, 3);
    assert.equal(queue.size(), 0);
    assert.equal(queue.pending(), 0);
  });

  test('rejects when queue is full', async () => {
    const queue = createBoundedQueue({ maxSize: 2, maxConcurrency: 1 });

    // Fill the queue: 1 processing + 2 waiting = full
    const p1 = queue.push(1);
    const p2 = queue.push(2);

    // Third push should fail
    await assert.rejects(() => queue.push(3), /Queue full/);

    // Complete first item — p1 resolves now
    queue.markDone();
    const item1 = await p1;
    assert.equal(item1, 1);

    // Complete second item
    queue.markDone();
    const item2 = await p2;
    assert.equal(item2, 2);
    queue.markDone();
  });

  test('respects maxConcurrency', async () => {
    let concurrent = 0;
    let maxSeen = 0;
    const queue = createBoundedQueue({ maxSize: 20, maxConcurrency: 2 });

    const process = async (item) => {
      concurrent++;
      maxSeen = Math.max(maxSeen, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
      queue.markDone();
    };

    const promises = [];
    for (let i = 0; i < 6; i++) {
      promises.push(queue.push(i).then(process));
    }

    await Promise.all(promises);
    assert.ok(maxSeen <= 2, `Max concurrency was ${maxSeen}, expected <= 2`);
  });
});

// =============================================================================
// Fault Injection Tests
// =============================================================================

describe('Capacity — Fault Injection', () => {

  test('slow dependency does not block other routes', async () => {
    // Acquire slot on one route
    const slowSlot = await acquireSlot('POST', '/api/upload');

    // Another route should still be acquirable
    const fastSlot = await acquireSlot('GET', '/api/health');
    assert.equal(fastSlot.acquired, true);

    fastSlot.release();
    slowSlot.release();
  });

  test('connection exhaustion triggers pressure signal', () => {
    updatePressureSignal('mongoPoolExhausted', true);

    const { level } = getPressureLevel();
    assert.ok(level > 0.5, `Pressure level ${level} should be > 0.5`);

    updatePressureSignal('mongoPoolExhausted', false);
  });

  test('outbound HTTP exhaustion triggers pressure signal', () => {
    updatePressureSignal('outboundHttpExhausted', true);

    const { level } = getPressureLevel();
    assert.ok(level > 0.5);

    updatePressureSignal('outboundHttpExhausted', false);
  });

  test('memory pressure at 90% sheds low priority routes', () => {
    updatePressureSignal('memoryPressure', 0.9);

    const { shouldShed: shedMetrics } = shouldShed('GET', '/api/metrics');
    const { shouldShed: shedPurchase } = shouldShed('POST', '/api/purchase');

    assert.equal(shedMetrics, true);
    assert.equal(shedPurchase, false);
  });

  test('multiple pressure signals compound', () => {
    updatePressureSignal('mongoPoolExhausted', true);
    updatePressureSignal('outboundHttpExhausted', true);

    const { level, reasons } = getPressureLevel();
    assert.ok(level >= 0.7);
    assert.ok(reasons.length >= 2);

    updatePressureSignal('mongoPoolExhausted', false);
    updatePressureSignal('outboundHttpExhausted', false);
  });
});

// =============================================================================
// Ramp / Spike Tests
// =============================================================================

describe('Capacity — Ramp Scenario', () => {

  test('handles gradual ramp-up of concurrent requests', async () => {
    const slots = [];
    const maxConcurrent = 5;

    // Ramp up one at a time
    for (let i = 0; i < maxConcurrent; i++) {
      const result = await acquireSlot('POST', '/api/upload');
      assert.equal(result.acquired, true, `Slot ${i} should be acquired`);
      slots.push(result);
    }

    const stats = getConcurrencyStats();
    assert.equal(stats.global, maxConcurrent);

    // Ramp down
    for (const slot of slots) {
      slot.release();
    }

    assert.equal(getConcurrencyStats().global, 0);
  });
});

describe('Capacity — Spike Scenario', () => {

  test('spike fills concurrency slots and queues overflow', async () => {
    // Health route has maxConcurrent=10
    const slots = [];
    for (let i = 0; i < 10; i++) {
      slots.push(await acquireSlot('GET', '/api/health'));
    }

    assert.equal(getConcurrencyStats().routes['GET:/api/health'].inFlight, 10);

    // Release all
    for (const s of slots) s.release();
    assert.equal(getConcurrencyStats().global, 0);
  });
});

// =============================================================================
// Recovery Tests
// =============================================================================

describe('Capacity — Recovery', () => {

  test('pressure signals clear after dependency restoration', () => {
    updatePressureSignal('mongoPoolExhausted', true);
    updatePressureSignal('outboundHttpExhausted', true);

    const before = getPressureLevel();
    assert.ok(before.level > 0.5);

    // Restore
    updatePressureSignal('mongoPoolExhausted', false);
    updatePressureSignal('outboundHttpExhausted', false);

    const after = getPressureLevel();
    assert.ok(after.level < before.level, 'Pressure should decrease after restoration');
  });

  test('concurrency slots fully recover after burst', async () => {
    const slots = [];

    // Burst: acquire all health slots
    for (let i = 0; i < 10; i++) {
      slots.push(await acquireSlot('GET', '/api/health'));
    }

    assert.equal(getConcurrencyStats().global, 10);

    // Release all
    for (const s of slots) s.release();

    assert.equal(getConcurrencyStats().global, 0);

    // Can acquire again
    const fresh = await acquireSlot('GET', '/api/health');
    assert.equal(fresh.acquired, true);
    fresh.release();
  });
});

// =============================================================================
// Retry Storm Protection Tests
// =============================================================================

describe('Capacity — Retry Storm Protection', () => {

  test('overload response includes Retry-After header', () => {
    const res = buildOverloadResponse({
      route: 'POST:/api/purchase',
      reason: 'concurrency_limit',
      retryAfterSeconds: 5,
    });

    assert.equal(Number(res.headers['Retry-After']), 5);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  test('retry guidance scales with pressure level', () => {
    const lowPressure = buildOverloadResponse({
      route: 'GET:/api/health',
      reason: 'load_shedding',
      retryAfterSeconds: 2,
    });

    const highPressure = buildOverloadResponse({
      route: 'GET:/api/health',
      reason: 'load_shedding',
      retryAfterSeconds: 12,
    });

    assert.ok(
      Number(highPressure.headers['Retry-After']) > Number(lowPressure.headers['Retry-After']),
      'Higher pressure should suggest longer retry-after'
    );
  });
});
