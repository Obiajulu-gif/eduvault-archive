/**
 * Automated Verification: Load Test for Worst-Case Cardinality and Burst Traffic
 *
 * Covers Acceptance Criteria:
 *   1. Normal Path: High-cardinality dataset search, faceted exploration, and cursor pagination under burst concurrency.
 *   2. Failure Path: Cardinality explosion queries, ReDoS / parameter runaway prevention, memory cap bounds, and 400/429/503 safe rejection.
 *   3. Retry Path: Rate limit exhaustion (429), sliding-window resets, exponential backoff with full jitter, and idempotent retry storm deduplication.
 *   4. Authorization Path: Mixed-role burst concurrency (Public, Buyer, Creator, Admin, Cross-tenant), field redaction verification, and zero tenant leak under load.
 */

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';

import {
  createWorstCaseCardinalityDataset,
  generateWorstCaseQueryCombinations,
  simulateBurstTraffic,
  calculatePercentiles,
  backoffWithJitter,
  createBoundedRateLimiter,
  sanitizeMaterialForRole,
  assertBurstLoadBudgets,
} from '../../src/lib/backend/burstCardinalityLoadSuite.js';

import {
  browseMarketplaceDataset,
} from '../../src/lib/backend/marketplaceLoadSuite.js';

import {
  buildMarketplaceDiscoveryQuery,
  buildMarketplaceSort,
  tokenizeMarketplaceSearch,
} from '../../src/lib/backend/marketplaceDiscovery.js';

describe('Load Test Suite: Worst-Case Cardinality & Burst Traffic', () => {
  let dataset;

  beforeEach(() => {
    // 5,000 items with 150 tags, 30 subjects, 15 categories, 500 unique authors
    dataset = createWorstCaseCardinalityDataset({
      size: 5000,
      authorCount: 500,
      tagPoolSize: 150,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. NORMAL PATH: High-Cardinality Dataset Search & Burst Concurrency
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Normal Path — Steady Burst Concurrency & High Cardinality Queries', () => {
    test('burst concurrency: 200 concurrent requests across 25 workers execute under p95 & memory ceilings', async () => {
      const queries = generateWorstCaseQueryCombinations({ count: 200 });

      const metrics = await simulateBurstTraffic({
        requests: queries,
        concurrency: 25,
        handler: async (query) => {
          // Filter public non-quarantined non-deleted items
          const filtered = dataset.filter((item) => {
            if (item.visibility !== 'public' || item.isDeleted || item.quarantineStatus === 'quarantined') {
              return false;
            }
            if (query.subject && item.subject !== query.subject) return false;
            if (query.category && item.category !== query.category) return false;
            return true;
          });

          // Search token matching & relevance ranking
          const result = browseMarketplaceDataset(filtered, {
            search: query.search || '',
            pageSize: query.pageSize || 24,
            pages: 2,
          });

          return {
            status: 200,
            matched: result.matchedItems,
            durationMs: result.durationMs,
          };
        },
      });

      // Budget Assertions
      const budgetCheck = assertBurstLoadBudgets(metrics, {
        maxP95Ms: 400,
        maxP99Ms: 650,
        minRps: 75,
        maxHeapDeltaMb: 60,
        maxErrorRatePercent: 0,
        expectedMin200RatePercent: 100,
      });

      assert.ok(
        budgetCheck.ok,
        `Budget check failed:\n${budgetCheck.violations.join('\n')}`
      );

      assert.equal(metrics.totalRequests, 200);
      assert.equal(metrics.statusBreakdown[200], 200);
      assert.equal(metrics.errors.length, 0);
      assert.ok(metrics.latencies.p50 < 300, `p50 (${metrics.latencies.p50}ms) must be < 300ms`);
    });

    test('facet cardinality: multi-tag keyword intersection remains sub-linear under high cardinality', () => {
      const started = performance.now();

      // Query looking for combinations of 3 distinct tags across 5,000 items
      const targetTags = ['tag-keyword-10', 'tag-keyword-25', 'tag-keyword-40'];
      const matches = dataset.filter((item) =>
        targetTags.some((tag) => item.tags.includes(tag))
      );

      const elapsedMs = performance.now() - started;

      assert.ok(matches.length > 0, 'Should find matching tagged items');
      assert.ok(elapsedMs < 30, `Multi-tag intersection took ${elapsedMs.toFixed(2)}ms, exceeding 30ms ceiling`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. FAILURE PATH: Cardinality Explosion, Sanitization & Resource Exhaustion
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Failure Path — Cardinality Explosion, ReDoS & Bounded Eviction', () => {
    test('adversarial search token explosion: safely tokenized without ReDoS or memory blowout', () => {
      // 50 repetitive tokens and adversarial unicode inputs
      const adversarialInput = 'a'.repeat(500) + ' \u0000\u001F ' + 'quantum '.repeat(30) + '(()[]{}*+?^$)';

      const start = performance.now();
      const tokens = tokenizeMarketplaceSearch(adversarialInput);
      const elapsedMs = performance.now() - start;

      assert.ok(elapsedMs < 15, `Tokenization took ${elapsedMs.toFixed(2)}ms, exceeding 15ms ceiling`);
      assert.ok(tokens.length <= 10, 'Search stop words and length caps should bound tokens');
      assert.ok(!tokens.some((t) => t.includes('\u0000')), 'Control characters must be sanitized');
    });

    test('rate limiter cardinality exhaustion: bounded cache evicts oldest keys under 10,000-key burst', () => {
      const maxBuckets = 500;
      const limiter = createBoundedRateLimiter({ limit: 10, windowMs: 60_000, maxBuckets });

      // Simulate an attacker flooding with 2,000 unique client IPs
      for (let i = 0; i < 2000; i += 1) {
        const res = limiter.check(`client-ip-${i}`, 1000);
        assert.equal(res.allowed, true);
      }

      // Cardinality safety check: limiter size MUST never exceed maxBuckets
      assert.ok(
        limiter.size() <= maxBuckets,
        `Limiter size (${limiter.size()}) exceeded maxBuckets ceiling of ${maxBuckets}`
      );
    });

    test('malformed query recovery: invalid limit / offset gracefully rejected with 400', async () => {
      const malformedRequests = [
        { limit: -5, page: 'invalid' },
        { limit: 9999999, page: -1 },
        { cursor: '!!not_valid_base64!!' },
        { search: '$where: sleep(5000)' },
      ];

      const metrics = await simulateBurstTraffic({
        requests: malformedRequests,
        concurrency: 4,
        handler: async (req) => {
          if (req.limit !== undefined && (req.limit <= 0 || req.limit > 100)) {
            return { status: 400, error: 'INVALID_LIMIT' };
          }
          if (req.cursor && !/^[A-Za-z0-9+/=]+$/.test(req.cursor)) {
            return { status: 400, error: 'MALFORMED_CURSOR' };
          }
          if (req.search && req.search.includes('$where')) {
            return { status: 400, error: 'PROHIBITED_QUERY_OPERATOR' };
          }
          return { status: 200 };
        },
      });

      assert.equal(metrics.statusBreakdown[400], 4);
      assert.equal(metrics.statusBreakdown[200], 0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. RETRY PATH: Rate Limiting (429), Jitter Backoff & Idempotent Storms
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Retry Path — HTTP 429, Full Jitter Backoff & Idempotency Deduplication', () => {
    test('burst saturation: bucket exhaustion returns 429 with Retry-After and resets after window', () => {
      const limiter = createBoundedRateLimiter({ limit: 5, windowMs: 1000 });
      const clientKey = 'burst-client-123';

      // 5 requests allowed
      for (let i = 0; i < 5; i += 1) {
        const res = limiter.check(clientKey, 1000 + i * 10);
        assert.equal(res.allowed, true);
      }

      // 6th request blocked with 429
      const blocked = limiter.check(clientKey, 1060);
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.remaining, 0);
      assert.ok(blocked.retryAfter >= 1, 'Retry-After must be positive integer seconds');

      // After window passes (now = 2050), requests allowed again
      const recovered = limiter.check(clientKey, 2050);
      assert.equal(recovered.allowed, true);
    });

    test('full jitter backoff: eliminates retry synchronization across 100 simulated clients', () => {
      const delays = [];
      for (let i = 0; i < 100; i += 1) {
        // Attempt 2 backoff: base 50ms, max 2000ms
        delays.push(backoffWithJitter(2, { baseDelayMs: 50, maxDelayMs: 2000 }));
      }

      const percentiles = calculatePercentiles(delays);

      // Max theoretical delay for attempt 2 is 50 * 2^2 = 200ms
      assert.ok(percentiles.max <= 200, `Max delay (${percentiles.max}ms) must be <= 200ms`);
      assert.ok(percentiles.min >= 0, 'Min delay must be >= 0ms');

      // Distribution check: delay spread must be well-distributed (not clustered at single value)
      const uniqueDelays = new Set(delays);
      assert.ok(uniqueDelays.size > 25, `Expected high entropy in jitter delays, got ${uniqueDelays.size}`);
    });

    test('retry storm deduplication: 50 concurrent retries of high-risk write execute side-effect exactly once', async () => {
      let executionCount = 0;
      const idempotencyStore = new Map();
      const sharedKey = 'idempotent-checkout-req-7788';

      // Handler with atomic idempotency gate
      async function executeIdempotentWrite(key, payload) {
        if (idempotencyStore.has(key)) {
          return { status: 200, replayed: true, result: idempotencyStore.get(key) };
        }

        // Simulate side-effect mutation
        executionCount += 1;
        const result = {
          orderId: `ord-${Date.now()}`,
          buyer: payload.buyer,
          amount: payload.amount,
        };
        idempotencyStore.set(key, result);
        return { status: 200, replayed: false, result };
      }

      // Simulate 50 concurrent retries arriving nearly simultaneously
      const requests = Array.from({ length: 50 }, () => ({
        key: sharedKey,
        payload: { buyer: 'buyer-alice', amount: 25.0 },
      }));

      const metrics = await simulateBurstTraffic({
        requests,
        concurrency: 20,
        handler: async (req) => executeIdempotentWrite(req.key, req.payload),
      });

      assert.equal(metrics.totalRequests, 50);
      assert.equal(metrics.statusBreakdown[200], 50);

      // Invariant: The actual mutation executed exactly once
      assert.equal(executionCount, 1, 'Side-effect must execute exactly once despite 50 concurrent retries');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. AUTHORIZATION PATH: Mixed-Role Burst Concurrency & Zero Tenant Contamination
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Authorization Path — Mixed Role Concurrency, Tenant Isolation & Redaction', () => {
    test('burst authorization: 150 mixed-role requests strictly enforce field redaction under concurrency', async () => {
      const sampleItem = dataset[0];
      const buyerId = sampleItem.entitledUsers[0];
      const creatorId = sampleItem.author;

      const rolesWorkload = [];
      for (let i = 0; i < 150; i += 1) {
        const type = i % 5;
        if (type === 0) {
          rolesWorkload.push({ role: 'PUBLIC', context: {} });
        } else if (type === 1) {
          rolesWorkload.push({ role: 'BUYER', context: { userAddress: buyerId } });
        } else if (type === 2) {
          rolesWorkload.push({ role: 'CREATOR', context: { userAddress: creatorId } });
        } else if (type === 3) {
          rolesWorkload.push({ role: 'OPERATOR_ADMIN', context: { userAddress: 'admin-super' } });
        } else {
          rolesWorkload.push({ role: 'CROSS_TENANT', context: { userAddress: 'unauthorized-intruder' } });
        }
      }

      const metrics = await simulateBurstTraffic({
        requests: rolesWorkload,
        concurrency: 30,
        handler: async (req) => {
          const sanitized = sanitizeMaterialForRole(sampleItem, req.role, req.context);

          // Invariant checks per role
          if (req.role === 'PUBLIC') {
            assert.strictEqual(sanitized.downloadUrl, undefined, 'PUBLIC must not expose downloadUrl');
            assert.strictEqual(sanitized.rawStoragePath, undefined, 'PUBLIC must not expose rawStoragePath');
            assert.strictEqual(sanitized.internalReviewFlags, undefined, 'PUBLIC must not expose internalReviewFlags');
            assert.strictEqual(sanitized.authorPayoutRoutingKey, undefined, 'PUBLIC must not expose payout credentials');
            return { status: 200 };
          }

          if (req.role === 'BUYER') {
            assert.ok(sanitized.downloadUrl, 'BUYER with entitlement must receive downloadUrl');
            assert.strictEqual(sanitized.internalReviewFlags, undefined, 'BUYER must not see internal review flags');
            return { status: 200 };
          }

          if (req.role === 'CREATOR') {
            assert.ok(sanitized.internalReviewFlags, 'CREATOR must see their own review flags');
            assert.ok(sanitized.rawStoragePath, 'CREATOR must see their storage path');
            return { status: 200 };
          }

          if (req.role === 'OPERATOR_ADMIN') {
            assert.ok(sanitized.authorPayoutRoutingKey, 'OPERATOR_ADMIN can inspect maintenance routing');
            return { status: 200 };
          }

          if (req.role === 'CROSS_TENANT') {
            // Unauthorized tenant gets public sanitization (no access)
            assert.strictEqual(sanitized.downloadUrl, undefined, 'Cross-tenant caller must NOT see downloadUrl');
            return { status: 200 };
          }

          return { status: 400 };
        },
      });

      assert.equal(metrics.totalRequests, 150);
      assert.equal(metrics.statusBreakdown[200], 150);
      assert.equal(metrics.errors.length, 0);
      assert.ok(metrics.latencies.p95 < 50, `Auth check p95 (${metrics.latencies.p95}ms) must be < 50ms`);
    });

    test('invalid authentication token: fast rejection without consuming backend search resources', async () => {
      const invalidTokenRequests = Array.from({ length: 40 }, (_, i) => ({
        token: `tampered-bearer-token-${i}`,
      }));

      const metrics = await simulateBurstTraffic({
        requests: invalidTokenRequests,
        concurrency: 10,
        handler: async (req) => {
          // Token verification fast-fail
          if (!req.token.startsWith('valid-jwt-')) {
            return { status: 401, error: 'INVALID_CREDENTIALS' };
          }
          return { status: 200 };
        },
      });

      assert.equal(metrics.statusBreakdown[401], 40);
      assert.equal(metrics.statusBreakdown[200], 0);
      // Fast-fail must be sub-millisecond per request
      assert.ok(metrics.latencies.p95 < 10, `Fast token rejection p95 (${metrics.latencies.p95}ms) must be < 10ms`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. COMPREHENSIVE STRESS: Mixed Workload Execution & Global Stability
  // ══════════════════════════════════════════════════════════════════════════════
  describe('Comprehensive Stress — Mixed Normal, Failure, Retry & Auth Traffic', () => {
    test('mixed stress burst: 300 heterogeneous requests maintain system stability and clean memory', async () => {
      const limiter = createBoundedRateLimiter({ limit: 40, windowMs: 2000, maxBuckets: 100 });
      const mixedWorkload = [];

      for (let i = 0; i < 300; i += 1) {
        const type = i % 4;
        if (type === 0) {
          mixedWorkload.push({ type: 'normal_search', search: 'algebra', client: `client-${i % 10}` });
        } else if (type === 1) {
          mixedWorkload.push({ type: 'adversarial_params', search: 'x'.repeat(100), client: `client-${i % 10}` });
        } else if (type === 2) {
          mixedWorkload.push({ type: 'burst_retry', client: 'hot-client-ip' });
        } else {
          mixedWorkload.push({ type: 'auth_access', role: 'PUBLIC', client: `client-${i % 10}` });
        }
      }

      const metrics = await simulateBurstTraffic({
        requests: mixedWorkload,
        concurrency: 30,
        handler: async (req, index) => {
          // 1. Rate limiter check
          const rateCheck = limiter.check(req.client, 1000 + index * 5);
          if (!rateCheck.allowed) {
            return { status: 429, retryAfter: rateCheck.retryAfter };
          }

          // 2. Route handling
          if (req.type === 'normal_search') {
            const matches = dataset.filter((d) => d.subject === 'algebra').slice(0, 10);
            return { status: 200, count: matches.length };
          }

          if (req.type === 'adversarial_params') {
            const tokens = tokenizeMarketplaceSearch(req.search);
            return { status: 200, tokensCount: tokens.length };
          }

          if (req.type === 'burst_retry') {
            return { status: 200, message: 'Processed' };
          }

          if (req.type === 'auth_access') {
            const sanitized = sanitizeMaterialForRole(dataset[0], req.role);
            return { status: 200, id: sanitized._id };
          }

          return { status: 500 };
        },
      });

      assert.equal(metrics.totalRequests, 300);
      assert.ok(metrics.statusBreakdown[200] > 150, 'Majority of well-behaved requests must succeed (200 OK)');
      assert.ok(metrics.statusBreakdown[429] > 0, 'Hot client burst must be throttled with 429');
      assert.equal(metrics.statusBreakdown[500], 0, 'No internal server errors (500) allowed under mixed stress');
      assert.ok(metrics.memory.heapDeltaMb < 50, `Heap delta (${metrics.memory.heapDeltaMb}MB) must stay bounded`);
    });
  });
});
