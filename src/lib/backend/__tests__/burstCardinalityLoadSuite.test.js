import { describe, it, expect } from 'vitest';
import {
  calculatePercentiles,
  backoffWithJitter,
  createBoundedRateLimiter,
  assertBurstLoadBudgets,
  sanitizeMaterialForRole,
  createWorstCaseCardinalityDataset,
  generateWorstCaseQueryCombinations,
  SUBJECTS_TAXONOMY,
  CATEGORIES_TAXONOMY,
} from '../burstCardinalityLoadSuite.js';

describe('burstCardinalityLoadSuite unit tests', () => {
  describe('calculatePercentiles', () => {
    it('returns zeroes for empty or null array', () => {
      const empty = calculatePercentiles([]);
      expect(empty.p50).toBe(0);
      expect(empty.p95).toBe(0);
      expect(empty.count).toBe(0);

      const nullInput = calculatePercentiles(null);
      expect(nullInput.count).toBe(0);
    });

    it('correctly calculates min, max, mean, and percentiles', () => {
      // 100 values from 1 to 100
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      const res = calculatePercentiles(values);

      expect(res.min).toBe(1);
      expect(res.max).toBe(100);
      expect(res.mean).toBe(50.5);
      expect(res.p50).toBe(50);
      expect(res.p90).toBe(90);
      expect(res.p95).toBe(95);
      expect(res.p99).toBe(99);
      expect(res.count).toBe(100);
    });
  });

  describe('backoffWithJitter', () => {
    it('bounds delay between 0 and exponential ceiling', () => {
      // Attempt 3: 50 * 2^3 = 400ms max
      const mockRandomMax = () => 0.999;
      const maxDelay = backoffWithJitter(3, {
        baseDelayMs: 50,
        maxDelayMs: 2000,
        randomFactor: mockRandomMax,
      });
      expect(maxDelay).toBeLessThanOrEqual(400);
      expect(maxDelay).toBeGreaterThanOrEqual(390);

      const mockRandomMin = () => 0.0;
      const minDelay = backoffWithJitter(3, {
        baseDelayMs: 50,
        maxDelayMs: 2000,
        randomFactor: mockRandomMin,
      });
      expect(minDelay).toBe(0);
    });

    it('caps delay at maxDelayMs regardless of attempt number', () => {
      const mockRandomMax = () => 1.0;
      const capped = backoffWithJitter(10, {
        baseDelayMs: 50,
        maxDelayMs: 1500,
        randomFactor: mockRandomMax,
      });
      expect(capped).toBeLessThanOrEqual(1500);
    });
  });

  describe('createBoundedRateLimiter', () => {
    it('allows requests within rate limit', () => {
      const limiter = createBoundedRateLimiter({ limit: 3, windowMs: 10_000 });
      const now = 5000;

      expect(limiter.check('ip1', now).allowed).toBe(true);
      expect(limiter.check('ip1', now + 100).allowed).toBe(true);
      expect(limiter.check('ip1', now + 200).allowed).toBe(true);

      const blocked = limiter.check('ip1', now + 300);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfter).toBeGreaterThan(0);
    });

    it('enforces maximum bucket capacity with eviction', () => {
      const maxBuckets = 5;
      const limiter = createBoundedRateLimiter({ limit: 5, windowMs: 10_000, maxBuckets });

      for (let i = 0; i < 15; i += 1) {
        limiter.check(`ip-${i}`, 1000);
      }

      expect(limiter.size()).toBeLessThanOrEqual(maxBuckets);
    });
  });

  describe('createWorstCaseCardinalityDataset', () => {
    it('synthesizes dataset matching requested size and taxonomies', () => {
      const dataset = createWorstCaseCardinalityDataset({ size: 100, authorCount: 10 });
      expect(dataset.length).toBe(100);

      const first = dataset[0];
      expect(SUBJECTS_TAXONOMY).toContain(first.subject);
      expect(CATEGORIES_TAXONOMY).toContain(first.category);
      expect(first.tags.length).toBeGreaterThan(0);
      expect(first).toHaveProperty('downloadUrl');
      expect(first).toHaveProperty('rawStoragePath');
    });
  });

  describe('generateWorstCaseQueryCombinations', () => {
    it('generates multi-faceted and adversarial search queries', () => {
      const queries = generateWorstCaseQueryCombinations({ count: 30 });
      expect(queries.length).toBe(30);

      // Contains deep faceted queries
      const deepFaceted = queries.find((q) => q.category && q.contentType);
      expect(deepFaceted).toBeDefined();

      // Contains adversarial queries
      const adversarial = queries.find((q) => q.page === 25);
      expect(adversarial).toBeDefined();
    });
  });

  describe('sanitizeMaterialForRole', () => {
    const raw = {
      _id: 'm-1',
      title: 'Advanced Calculus',
      author: 'creator-99',
      entitledUsers: ['buyer-1'],
      downloadUrl: 'https://internal/archive.zip',
      rawStoragePath: '/data/ipfs/123',
      internalReviewFlags: { score: 10 },
      authorPayoutRoutingKey: 'routing-xyz',
    };

    it('strictly redacts sensitive fields for PUBLIC', () => {
      const clean = sanitizeMaterialForRole(raw, 'PUBLIC', {});
      expect(clean.downloadUrl).toBeUndefined();
      expect(clean.rawStoragePath).toBeUndefined();
      expect(clean.internalReviewFlags).toBeUndefined();
      expect(clean.authorPayoutRoutingKey).toBeUndefined();
      expect(clean._sanitizationScope).toBe('PUBLIC');
    });

    it('grants download access to entitled BUYER', () => {
      const entitled = sanitizeMaterialForRole(raw, 'BUYER', { userAddress: 'buyer-1' });
      expect(entitled.downloadUrl).toBe('https://internal/archive.zip');
      expect(entitled.internalReviewFlags).toBeUndefined();
      expect(entitled._sanitizationScope).toBe('BUYER');
    });

    it('falls back to PUBLIC for non-entitled buyer', () => {
      const nonEntitled = sanitizeMaterialForRole(raw, 'BUYER', { userAddress: 'stranger' });
      expect(nonEntitled.downloadUrl).toBeUndefined();
      expect(nonEntitled._sanitizationScope).toBe('PUBLIC');
    });

    it('exposes creator storage path to owning CREATOR', () => {
      const creator = sanitizeMaterialForRole(raw, 'CREATOR', { userAddress: 'creator-99' });
      expect(creator.rawStoragePath).toBe('/data/ipfs/123');
      expect(creator.internalReviewFlags).toEqual({ score: 10 });
      expect(creator._sanitizationScope).toBe('CREATOR');
    });

    it('exposes full audit payload to OPERATOR_ADMIN', () => {
      const admin = sanitizeMaterialForRole(raw, 'OPERATOR_ADMIN', {});
      expect(admin.authorPayoutRoutingKey).toBe('routing-xyz');
      expect(admin._sanitizationScope).toBe('OPERATOR_ADMIN');
    });
  });

  describe('assertBurstLoadBudgets', () => {
    it('detects latency, throughput, and memory violations', () => {
      const failingMetrics = {
        totalRequests: 100,
        rps: 20,
        latencies: { p95: 350, p99: 700 },
        memory: { heapDeltaMb: 85 },
        statusBreakdown: { 200: 50, 500: 10 },
        errors: [{ error: 'Timeout' }],
      };

      const check = assertBurstLoadBudgets(failingMetrics, {
        maxP95Ms: 200,
        maxP99Ms: 500,
        minRps: 50,
        maxHeapDeltaMb: 50,
        maxErrorRatePercent: 0,
        expectedMin200RatePercent: 90,
      });

      expect(check.ok).toBe(false);
      expect(check.violations.length).toBeGreaterThanOrEqual(4);
    });

    it('passes when all metrics meet budget floors and ceilings', () => {
      const passingMetrics = {
        totalRequests: 100,
        rps: 250,
        latencies: { p95: 80, p99: 120 },
        memory: { heapDeltaMb: 15 },
        statusBreakdown: { 200: 100 },
        errors: [],
      };

      const check = assertBurstLoadBudgets(passingMetrics, {
        maxP95Ms: 100,
        maxP99Ms: 200,
        minRps: 100,
        maxHeapDeltaMb: 40,
        maxErrorRatePercent: 0,
        expectedMin200RatePercent: 95,
      });

      expect(check.ok).toBe(true);
      expect(check.violations.length).toBe(0);
    });
  });
});
