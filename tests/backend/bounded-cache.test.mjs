import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBoundedCache,
  PUBLIC_SCOPE,
  LookupStatus,
  assertCacheScopeAuthorized,
  CacheAuthorizationError,
} from '../../src/lib/cache/boundedCache.js';

function makeCache(options = {}) {
  let clock = 1_000_000;
  const sleeps = [];
  const cache = createBoundedCache({
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); },
    ...options,
  });
  return { cache, getClock: () => clock, advanceClock: (ms) => { clock += ms; }, sleeps };
}

describe('bounded cache invalidation and stale detection (#1149)', () => {
  describe('normal path', () => {
    it('stores and retrieves cached values with defensive copies', () => {
      const { cache } = makeCache();
      const original = { title: 'Math 101', chapters: [1, 2] };

      const setOk = cache.set('mat-1', original, { scope: PUBLIC_SCOPE });
      assert.equal(setOk, true);

      // Mutate original - should not affect cache
      original.chapters.push(3);

      const cached = cache.get('mat-1', { scope: PUBLIC_SCOPE });
      assert.deepEqual(cached, { title: 'Math 101', chapters: [1, 2] });

      // Mutate retrieved copy - should not affect cache
      cached.chapters.push(4);
      assert.deepEqual(cache.get('mat-1', { scope: PUBLIC_SCOPE }), { title: 'Math 101', chapters: [1, 2] });
    });

    it('enforces LRU eviction at maxEntries', () => {
      const { cache } = makeCache({ maxEntries: 2 });
      cache.set('a', 1, { scope: PUBLIC_SCOPE });
      cache.set('b', 2, { scope: PUBLIC_SCOPE });

      // Access 'a' to make it most recently used
      cache.get('a', { scope: PUBLIC_SCOPE });

      // Inserting 'c' should evict 'b' (least recently used)
      cache.set('c', 3, { scope: PUBLIC_SCOPE });

      assert.equal(cache.get('b', { scope: PUBLIC_SCOPE }), undefined);
      assert.equal(cache.get('a', { scope: PUBLIC_SCOPE }), 1);
      assert.equal(cache.get('c', { scope: PUBLIC_SCOPE }), 3);
      assert.equal(cache.stats().evictions, 1);
      assert.equal(cache.stats().size, 2);
    });

    it('enforces maxBytes limit and invalidates by tag and prefix', () => {
      const { cache } = makeCache({ maxBytes: 100, sizeOf: (v) => v.length });
      cache.set('course:1', 'x'.repeat(40), { scope: PUBLIC_SCOPE, tags: ['course'] });
      cache.set('course:2', 'y'.repeat(40), { scope: PUBLIC_SCOPE, tags: ['course'] });

      assert.equal(cache.stats().bytes, 80);

      // Invalidate by tag
      const removedByTag = cache.invalidateTag('course');
      assert.equal(removedByTag, 2);
      assert.equal(cache.get('course:1', { scope: PUBLIC_SCOPE }), undefined);
      assert.equal(cache.stats().bytes, 0);

      // Invalidate by prefix
      cache.set('user:profile:1', 'p1', { scope: PUBLIC_SCOPE });
      cache.set('user:profile:2', 'p2', { scope: PUBLIC_SCOPE });
      cache.set('item:1', 'i1', { scope: PUBLIC_SCOPE });

      const removedByPrefix = cache.invalidatePrefix('user:profile:');
      assert.equal(removedByPrefix, 2);
      assert.equal(cache.get('item:1', { scope: PUBLIC_SCOPE }), 'i1');
    });
  });

  describe('failure path', () => {
    it('rejects invalid keys, empty scopes, and negative TTLs', () => {
      const { cache } = makeCache();

      assert.throws(() => cache.set('', 'val', { scope: PUBLIC_SCOPE }));
      assert.throws(() => cache.set('key', 'val', { scope: '' }));
      assert.throws(() => cache.set('key', 'val', { scope: PUBLIC_SCOPE, ttlMs: -100 }));
      assert.throws(() => cache.set('bad\u0000key', 'val', { scope: PUBLIC_SCOPE }));
    });

    it('gracefully refuses uncopyable values and oversized single entries without throwing', () => {
      const { cache } = makeCache({ maxBytes: 50, sizeOf: (v) => v.length });

      // Uncopyable (contains function)
      const uncopyable = { fn: () => {} };
      assert.equal(cache.set('uncopyable', uncopyable, { scope: PUBLIC_SCOPE }), false);
      assert.equal(cache.stats().rejected, 1);

      // Oversized single entry
      assert.equal(cache.set('huge', 'z'.repeat(100), { scope: PUBLIC_SCOPE }), false);
      assert.equal(cache.stats().rejected, 2);
    });
  });

  describe('retry path', () => {
    it('retries transient loader errors with exponential backoff', async () => {
      const { cache, sleeps } = makeCache();
      let attempts = 0;

      const loader = async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('Transient DB timeout');
          err.retryable = true;
          throw err;
        }
        return { data: 'loaded-ok' };
      };

      const result = await cache.getOrLoad('key-1', loader, {
        scope: PUBLIC_SCOPE,
        retries: 3,
        retryDelayMs: 20,
      });

      assert.deepEqual(result, { value: { data: 'loaded-ok' }, source: 'loader', stale: false });
      assert.equal(attempts, 3);
      assert.equal(sleeps.length, 2);
      assert.equal(sleeps[0], 20);
      assert.equal(sleeps[1], 40);
    });

    it('aborts retries immediately on non-retryable error (e.g. authorization error)', async () => {
      const { cache } = makeCache();
      let attempts = 0;

      const loader = async () => {
        attempts++;
        const authErr = new Error('Permission denied');
        authErr.retryable = false;
        throw authErr;
      };

      await assert.rejects(async () => {
        await cache.getOrLoad('secret-key', loader, {
          scope: PUBLIC_SCOPE,
          retries: 3,
        });
      }, /Permission denied/);

      assert.equal(attempts, 1);
    });

    it('falls back to stale cache entry when retries are exhausted and entry is within stale grace', async () => {
      const { cache, advanceClock } = makeCache({ defaultTtlMs: 500, staleGraceMs: 2000 });

      // Pre-seed an entry
      cache.set('res-1', { version: 'stale-data' }, { scope: PUBLIC_SCOPE });

      // Expire the entry past TTL but within staleGraceMs
      advanceClock(600);

      // Lookup shows expired
      assert.equal(cache.lookup('res-1', { scope: PUBLIC_SCOPE }).status, LookupStatus.EXPIRED);

      // Now attempt reload from loader which fails
      const loader = async () => {
        throw new Error('Upstream service completely down');
      };

      const result = await cache.getOrLoad('res-1', loader, {
        scope: PUBLIC_SCOPE,
        retries: 1,
        serveStaleOnError: true,
      });

      assert.equal(result.stale, true);
      assert.equal(result.source, 'stale-cache');
      assert.deepEqual(result.value, { version: 'stale-data' });
      assert.equal(cache.stats().staleServed, 1);
    });
  });

  describe('authorization path', () => {
    it('strictly isolates scopes and prevents cross-scope data leakage', () => {
      const { cache } = makeCache();

      // Alice caches her private draft
      cache.set('draft:1', { secret: 'alice-draft' }, { scope: 'user:alice_id' });

      // Bob cannot read Alice's draft
      assert.equal(cache.get('draft:1', { scope: 'user:bob_id' }), undefined);
      assert.equal(cache.get('draft:1', { scope: PUBLIC_SCOPE }), undefined);

      // Alice can read her own draft
      assert.deepEqual(cache.get('draft:1', { scope: 'user:alice_id' }), { secret: 'alice-draft' });
    });

    it('assertCacheScopeAuthorized validates actor permissions against scope', () => {
      assert.equal(assertCacheScopeAuthorized(null, PUBLIC_SCOPE), true);
      assert.equal(assertCacheScopeAuthorized({ id: 'user_1' }, 'user:user_1'), true);
      assert.equal(assertCacheScopeAuthorized({ role: 'admin' }, 'user:any_user'), true);
      assert.equal(assertCacheScopeAuthorized({ role: 'service' }, 'user:any_user'), true);

      assert.throws(() => assertCacheScopeAuthorized(null, 'user:user_1'), CacheAuthorizationError);
      assert.throws(
        () => assertCacheScopeAuthorized({ id: 'bob' }, 'user:alice'),
        CacheAuthorizationError
      );
    });

    it('enforces actor authorization when actor option is supplied to cache calls', () => {
      const { cache } = makeCache();

      assert.throws(() => {
        cache.set('item', 'val', { scope: 'user:victim', actor: { id: 'attacker' } });
      }, CacheAuthorizationError);

      assert.doesNotThrow(() => {
        cache.set('item', 'val', { scope: 'user:alice', actor: { id: 'alice' } });
      });

      assert.throws(() => {
        cache.lookup('item', { scope: 'user:alice', actor: { id: 'mallory' } });
      }, CacheAuthorizationError);
    });
  });

  describe('stale detection and audit', () => {
    it('detects version mismatch as LookupStatus.STALE and drops cached entry', () => {
      const { cache } = makeCache();
      cache.set('doc:1', 'version-1-content', { scope: PUBLIC_SCOPE, version: 1 });

      const hit = cache.lookup('doc:1', { scope: PUBLIC_SCOPE, version: 1 });
      assert.equal(hit.status, LookupStatus.HIT);

      // Query with version 2 - should report stale and purge
      const staleLookup = cache.lookup('doc:1', { scope: PUBLIC_SCOPE, version: 2 });
      assert.equal(staleLookup.status, LookupStatus.STALE);
      assert.equal(staleLookup.cachedVersion, 1);
      assert.equal(staleLookup.currentVersion, 2);

      // Subsequent query is a clean MISS ready for fresh loading
      assert.equal(cache.lookup('doc:1', { scope: PUBLIC_SCOPE, version: 2 }).status, LookupStatus.MISS);
      assert.equal(cache.stats().staleVersion, 1);
    });

    it('findStale audits outdated entries and purgeStale removes them safely', () => {
      const { cache, advanceClock } = makeCache({ defaultTtlMs: 10_000, staleGraceMs: 500 });
      cache.set('valid', 'v1', { scope: PUBLIC_SCOPE, version: 2, ttlMs: 10_000 });
      cache.set('stale-version', 'v0', { scope: PUBLIC_SCOPE, version: 1, ttlMs: 10_000 });
      cache.set('expired', 'v1', { scope: PUBLIC_SCOPE, version: 2, ttlMs: 500 });

      advanceClock(1200); // 'expired' is now past 500 + 500 ms (past TTL + stale grace)

      const findings = cache.findStale({
        versionFor: (entry) => (entry.key === 'stale-version' ? 2 : entry.version),
      });

      assert.equal(findings.length, 2);
      assert.equal(findings.some((f) => f.reason === 'expired'), true);
      assert.equal(findings.some((f) => f.reason === 'version_behind'), true);

      const purgeResult = cache.purgeStale({
        versionFor: (entry) => (entry.key === 'stale-version' ? 2 : entry.version),
      });

      assert.equal(purgeResult.removed, 2);
      assert.equal(cache.get('stale-version', { scope: PUBLIC_SCOPE }), undefined);
      assert.equal(cache.get('valid', { scope: PUBLIC_SCOPE }), 'v1');
    });
  });
});
