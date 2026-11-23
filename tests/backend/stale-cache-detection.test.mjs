/**
 * tests/backend/stale-cache-detection.test.mjs
 *
 * Automated verification for stale-cache detection with repair
 * recommendations (issue #1097). Covers normal, failure, retry, and
 * authorization paths plus edge cases and rollback documentation.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { createBoundedCache } from '../../src/lib/cache/boundedCache.js';
import {
  STALE_REASON,
  REPAIR_ACTION,
  STALE_SEVERITY,
  StaleCacheAuthError,
  StaleCacheValidationError,
  StaleCacheRepairError,
  detectStaleCache,
  recommendRepair,
  buildStaleCacheReport,
  createStaleCacheRepairer,
  registerCacheForMonitoring,
  unregisterCache,
  clearMonitoredCaches,
  buildRegisteredCacheReport,
} from '../../src/lib/cache/staleCacheDetector.js';

const NOW = 1_000_000;

function entry(overrides = {}) {
  return {
    scope: 'public',
    key: 'subjects:list',
    value: [{ id: 's-1' }],
    version: 3,
    tags: ['marketplace'],
    storedAt: NOW - 1_000,
    expiresAt: NOW + 5_000,
    ...overrides,
  };
}

// ─── Normal path ──────────────────────────────────────────────────────────

describe('stale-cache detection — normal path (#1097)', () => {
  it('reports no findings for a fresh, version-matched cache', () => {
    const report = buildStaleCacheReport({
      entries: [entry()],
      now: () => NOW,
      versionFor: () => 3,
    });

    assert.equal(report.findings.length, 0);
    assert.equal(report.summary.total, 0);
    assert.equal(report.dryRun, true);
    assert.match(report.fingerprint, /^[a-f0-9]{64}$/);
  });

  it('accepts a bounded cache snapshot directly without mutating it', () => {
    const cache = createBoundedCache({ now: () => NOW });
    cache.set('subjects:list', ['a'], { scope: 'public', ttlMs: 5_000, version: 1 });

    const before = cache.stats();
    const findings = detectStaleCache({ cache, now: () => NOW, versionFor: () => 1 });
    const after = cache.stats();

    assert.deepEqual(findings, []);
    assert.equal(after.hits, before.hits);
    assert.equal(after.size, before.size);
  });

  it('produces a stable fingerprint for identical inputs', () => {
    const options = { entries: [entry(), entry({ key: 'b', scope: 'public' })], now: () => NOW };
    assert.equal(
      buildStaleCacheReport(options).fingerprint,
      buildStaleCacheReport(options).fingerprint,
    );
  });
});

// ─── Failure / detection path ─────────────────────────────────────────────

describe('stale-cache detection — failure path (#1097)', () => {
  it('detects entries expired past the grace window as critical', () => {
    const findings = detectStaleCache({
      entries: [entry({ expiresAt: NOW - 2_000, tags: ['subjects'] })],
      now: () => NOW,
      staleGraceMs: 500,
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].reason, STALE_REASON.EXPIRED_PAST_GRACE);
    assert.equal(findings[0].severity, STALE_SEVERITY.CRITICAL);
    assert.equal(findings[0].expiredForMs, 2_000);
  });

  it('distinguishes the grace window from fully expired entries', () => {
    const findings = detectStaleCache({
      entries: [entry({ expiresAt: NOW - 100 })],
      now: () => NOW,
      staleGraceMs: 500,
    });

    assert.equal(findings[0].reason, STALE_REASON.EXPIRED);
    assert.equal(findings[0].severity, STALE_SEVERITY.HIGH);
  });

  it('detects version drift against the authoritative source', () => {
    const findings = detectStaleCache({
      entries: [entry({ version: 2, tags: ['checkout']) })],
      now: () => NOW,
      versionFor: () => 4,
    });

    assert.equal(findings[0].reason, STALE_REASON.VERSION_BEHIND);
    assert.equal(findings[0].cachedVersion, 2);
    assert.equal(findings[0].currentVersion, 4);
    assert.equal(findings[0].severity, STALE_SEVERITY.CRITICAL); // critical tag
    assert.equal(findings[0].critical, true);
  });

  it('detects overdue verification and missing values', () => {
    const findings = detectStaleCache({
      entries: [
        entry({ key: 'a', lastVerifiedAt: NOW - 10_000 }),
        entry({ key: 'b', value: null }),
      ],
      now: () => NOW,
      verificationTtlMs: 5_000,
    });

    assert.deepEqual(findings.map((f) => f.reason), [STALE_REASON.UNVERIFIED, STALE_REASON.MISSING_VALUE]);
  });

  it('every finding carries an actionable recommendation with rollback', () => {
    const report = buildStaleCacheReport({
      entries: [
        entry({ key: 'expired', expiresAt: NOW - 10 }),
        entry({ key: 'drift', version: 1 }),
        entry({ key: 'unverified', lastVerifiedAt: NOW - 9_999 }),
      ],
      now: () => NOW,
      versionFor: (e) => (e.key === 'drift' ? 2 : e.version),
      verificationTtlMs: 1_000,
    });

    assert.equal(report.findings.length, 3);
    for (const finding of report.findings) {
      assert.equal(finding.recommendation.requiresAuthorization, true);
      assert.ok(finding.recommendation.steps.length > 0);
      assert.match(finding.recommendation.rollback, /\S/);
      assert.equal(finding.recommendation.scope, finding.scope);
      assert.equal(finding.recommendation.key, finding.key);
    }
    assert.deepEqual(
      report.findings.map((f) => f.recommendation.action),
      [REPAIR_ACTION.REFRESH, REPAIR_ACTION.INVALIDATE_AND_REFILL, REPAIR_ACTION.VERIFY_SOURCE],
    );
  });

  it('validates malformed inputs instead of silently skipping them', () => {
    assert.throws(() => detectStaleCache({}), StaleCacheValidationError);
    assert.throws(() => detectStaleCache({ entries: [{ value: 1 }] }), StaleCacheValidationError);
    assert.throws(() => detectStaleCache({ entries: [], versionFor: 'nope' }), StaleCacheValidationError);
    assert.throws(() => detectStaleCache({ entries: [], staleGraceMs: -1 }), StaleCacheValidationError);
  });
});

// ─── Retry / repair path ──────────────────────────────────────────────────

describe('stale-cache repair — retry path (#1097)', () => {
  const recommendation = {
    action: REPAIR_ACTION.INVALIDATE_AND_REFILL,
    scope: 'public',
    key: 'subjects:list',
    risk: STALE_SEVERITY.HIGH,
    rollback: 'Leave key invalidated; next read falls through to source.',
  };

  it('dry-runs by default and never invokes the repair handler', async () => {
    let calls = 0;
    const repairer = createStaleCacheRepairer({
      authorize: async () => true,
      repair: async () => { calls += 1; },
    });

    const result = await repairer.apply({ recommendation, principal: { id: 'op-1', role: 'operator' } });

    assert.equal(result.applied, false);
    assert.equal(result.attempts, 0);
    assert.equal(result.dryRun, true);
    assert.equal(calls, 0);
    assert.equal(repairer.stats().previews, 1);
  });

  it('retries transient failures with backoff then succeeds', async () => {
    const delays = [];
    let calls = 0;
    const repairer = createStaleCacheRepairer({
      authorize: async () => true,
      maxAttempts: 3,
      retryDelayMs: 10,
      sleep: async (ms) => { delays.push(ms); },
      repair: async ({ attempt }) => {
        calls += 1;
        if (attempt < 3) throw new Error('temporary source failure');
        return { removed: 1 };
      },
    });

    const result = await repairer.apply({
      recommendation,
      principal: { id: 'op-1', role: 'operator' },
      dryRun: false,
      reason: 'incident-42',
    });

    assert.equal(result.applied, true);
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [10, 20]);
    assert.equal(repairer.stats().retries, 2);
    assert.equal(result.reason, 'incident-42');
  });

  it('does not retry permanent failures and exposes structured errors', async () => {
    let calls = 0;
    const repairer = createStaleCacheRepairer({
      authorize: async () => true,
      repair: async () => {
        calls += 1;
        const error = new Error('cache is read-only');
        error.retryable = false;
        throw error;
      },
    });

    await assert.rejects(
      () => repairer.apply({ recommendation, principal: { id: 'op-1' }, dryRun: false }),
      (err) => err instanceof StaleCacheRepairError
        && err.code === 'STALE_CACHE_REPAIR_FAILED'
        && err.key === recommendation.key
        && err.attempts === 3,
    );
    assert.equal(calls, 1, 'permanent errors must not be retried');
  });

  it('actually invalidates the target entry when applied for real', async () => {
    let removed = null;
    const repairer = createStaleCacheRepairer({
      authorize: async () => true,
      repair: async ({ key, scope }) => {
        removed = { key, scope };
        return { removed: 1 };
      },
    });

    await repairer.apply({ recommendation, principal: { id: 'op-1' }, dryRun: false });
    assert.deepEqual(removed, { key: 'subjects:list', scope: 'public' });
  });
});

// ─── Authorization path ───────────────────────────────────────────────────

describe('stale-cache repair — authorization path (#1097)', () => {
  it('rejects unauthenticated and unauthorized principals before repair', async () => {
    let calls = 0;
    const repairer = createStaleCacheRepairer({
      authorize: async (principal) => principal?.role === 'admin',
      repair: async () => { calls += 1; },
    });

    await assert.rejects(
      () => repairer.apply({ recommendation: { action: REPAIR_ACTION.REFRESH }, principal: null, dryRun: false }),
      StaleCacheAuthError,
    );
    await assert.rejects(
      () => repairer.apply({ recommendation: { action: REPAIR_ACTION.REFRESH }, principal: { id: 'u', role: 'learner' }, dryRun: false }),
      StaleCacheAuthError,
    );
    assert.equal(calls, 0);
    assert.equal(repairer.stats().rejected, 2);
  });

  it('rejects even a dry run when the authorization gate fails', async () => {
    const repairer = createStaleCacheRepairer({ authorize: async () => { throw new Error('auth unavailable'); } });
    await assert.rejects(
      () => repairer.apply({ recommendation: { action: REPAIR_ACTION.REFRESH }, principal: {} }),
      StaleCacheAuthError,
    );
    assert.equal(repairer.stats().previews, 0);
  });

  it('denies by default when no authorize hook is supplied', async () => {
    const repairer = createStaleCacheRepairer();
    await assert.rejects(
      () => repairer.apply({ recommendation: { action: REPAIR_ACTION.REFRESH }, principal: { id: 'x' } }),
      StaleCacheAuthError,
    );
  });
});

// ─── Registry / route helper path ─────────────────────────────────────────

describe('monitored cache registry (#1097)', () => {
  beforeEach(() => {
    clearMonitoredCaches();
  });

  it('builds an aggregated report only for explicitly registered caches', () => {
    const cache = createBoundedCache({ now: () => NOW });
    cache.set('k', 'v', { scope: 'public', ttlMs: 1_000, version: 1 });
    registerCacheForMonitoring('subjects', cache);

    const report = buildRegisteredCacheReport({ now: () => NOW + 5_000 });

    assert.equal(report.summary.cacheCount, 1);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].cacheName, 'subjects');
    assert.equal(report.findings[0].reason, STALE_REASON.EXPIRED_PAST_GRACE);

    unregisterCache('subjects');
    assert.equal(buildRegisteredCacheReport({ now: () => NOW }).summary.cacheCount, 0);
  });

  it('validates registration and recommendRepair inputs', () => {
    assert.throws(() => registerCacheForMonitoring('', {}), StaleCacheValidationError);
    assert.throws(() => registerCacheForMonitoring('x', {}), StaleCacheValidationError);
    assert.throws(() => recommendRepair({ reason: 'UNKNOWN' }), StaleCacheValidationError);
  });
});
