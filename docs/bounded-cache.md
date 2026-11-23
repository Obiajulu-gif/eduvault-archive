# Bounded Cache

`src/lib/cache/boundedCache.js` is a process-local cache with hard size limits, explicit invalidation and stale detection. Tests: `src/lib/cache/boundedCache.test.js`.

It complements the Redis catalog cache (`src/lib/cache/redis.js`, bounded by TTL and a revision counter) and is for hot, small, safe-to-recompute data inside one server process. It does not replace Redis for anything that has to be consistent across instances.

```js
import { createBoundedCache, PUBLIC_SCOPE } from "@/lib/cache/boundedCache";

const materials = createBoundedCache({ maxEntries: 500, maxBytes: 4 * 1024 * 1024, defaultTtlMs: 30_000, staleGraceMs: 5 * 60_000 });

const { value, stale } = await materials.getOrLoad(`material:${id}`, () => loadMaterial(id), {
  scope: PUBLIC_SCOPE,          // or `user:${walletAddress}` for permission-dependent data
  tags: [`material:${id}`],
  version: material.version,    // source version the caller currently believes in
  retries: 2,
});

// after a write
materials.invalidateTag(`material:${id}`);
```

## Bounds

| Limit | Behavior |
| ----- | -------- |
| `maxEntries` (500) | Least recently used entry is evicted first. |
| `maxBytes` (8 MiB) | Estimated from the JSON size (override with `sizeOf`). Evicts LRU until under the limit. |
| One entry larger than `maxBytes` | Not cached; any older copy of that key is removed so it cannot be served as current. Counted in `rejected`. |
| Uncopyable / unserializable value | Not cached, returns `false`; never throws into the request path. |
| `ttlMs` | Entries past expiry are never returned by `get`. |

Values are copied in and out (`structuredClone`) so a caller mutating a result cannot corrupt the cache. Turn this off with `cloneValues: false` only for values you freeze.

## Authorization

`scope` is required on every call and is part of the key. A viewer's entries are never returned for another viewer or for `PUBLIC_SCOPE`. Scope and key may not contain NUL, so a crafted key cannot impersonate another scope. Use `PUBLIC_SCOPE` only for data every caller may read; cache permission-dependent data under the viewer's own scope. When a viewer's access changes (role, suspension, revoked entitlement, session revoke) call `invalidateScope("user:...")`.

## Invalidation

All return the number of entries removed and are safe to call repeatedly.

- `invalidate(key, {scope})`, one entry
- `invalidateTag(tag)`, every entry tagged, across scopes (preferred after a write)
- `invalidateScope(scope)`, everything one viewer has cached
- `invalidatePrefix(prefix, {scope?})`
- `clear()`

Every invalidation also drops in-flight loads from the single-flight table and marks loads started before it as not cacheable. A read that raced a write therefore returns its (possibly old) value to its own caller but never writes it back into the cache.

## Stale detection

- **Version check on read.** Pass `version` (the source row's `version`, a revision counter, etc.). An entry stored under a different version is reported `stale`, removed, and reloaded.
- **Expired entries** are never returned as hits.
- **Audit.** `findStale({ versionFor })` lists entries that are expired past grace or behind `versionFor(entry)`; `purgeStale` removes them. Use it from a reconcile job or an admin diagnostics route, next to `detectStaleCacheKeys` in `staleIndexDetection.js`.
- **`stats()`** exposes hits, misses, expiries, version-stale drops, evictions, rejections, load failures, retries and `hitRate` for dashboards.

## Failure and retry behavior

- A failed load is never cached; the next call tries again.
- `retries` re-runs the loader with exponential backoff (`retryDelayMs`, doubling). Errors with `retryable === false` (e.g. authorization failures) are not retried.
- If the load still fails and an entry for the same key and version is inside `staleGraceMs`, it is returned with `stale: true, source: "stale-cache"` instead of failing the request. Leave `staleGraceMs` at 0 (default) or pass `serveStaleOnError: false` for data that must never be served outdated, such as entitlement decisions.
- Concurrent callers for one key share one load.

## Operational edge cases

- **Multi-instance deployments.** Invalidation is per process. For data that other instances also change, keep TTLs short, pass `version` so a changed source is noticed on the next read, or use the Redis revision counter as `version`.
- **Restart / deploy.** The cache is empty after a restart; the first requests hit the source. There is nothing to migrate or restore.
- **Memory pressure.** Lower `maxEntries` / `maxBytes` and redeploy, or call `clear()`. `stats().size`/`bytes` shows what it holds.
- **Suspected bad cached data.** `clear()` (or `invalidateTag`) is always safe; the next read reloads from the source of truth.
- **Clock changes.** TTLs use `Date.now()`. A clock jump forward expires entries early; a jump back keeps them longer, bounded by the entry's TTL as measured against the new clock.

## Compatibility and rollback

Additive: a new module with no callers changed. Existing Redis behavior and exports (`cacheGet`, `cacheSet`, `catalogCacheKey`, `invalidateCatalogCache`) are untouched. To adopt it for a read path, wrap the loader with `getOrLoad` and call the matching invalidation from the existing write path. To roll back an adoption, remove the wrapper and the invalidation call; there is no persisted state.


---

## Bounded Cache Execution Paths (#1149)

### 1. Normal Path
- **Reads / Writes:** `cache.set(key, value, { scope })` defensively deep-clones the value and stores it with an estimated byte size. `cache.get(key, { scope })` or `cache.lookup()` returns a deep copy to prevent mutation of the cache store.
- **LRU & Byte Eviction:** Accessing an entry moves it to the most-recently-used position. When total entries exceed `maxEntries` or total payload bytes exceed `maxBytes`, the least recently used entries are evicted.
- **Single-Flight In-Flight Coalescing:** Multiple concurrent calls to `getOrLoad` for the same key share a single running loader promise, preventing cache stampedes.

### 2. Failure Path
- **Validation:** Keys, scopes, and tag names containing invalid characters (such as NUL bytes) or empty strings throw `AppError("VALIDATION_FIELD")`.
- **Unserializable Values:** Values containing functions or circular references return `false` without throwing, incrementing `counters.rejected`.
- **Oversized Payloads:** Payloads larger than `maxBytes` are rejected immediately to prevent cache blowout, and any older copy is purged so stale data cannot be served.
- **Loader Failures:** If a loader throws a non-retryable error (e.g. `err.retryable === false`), retries are immediately aborted.

### 3. Retry Path
- **Exponential Backoff:** If the loader throws a retryable error, `getOrLoad` retries up to `retries` times, doubling the delay on each attempt (`retryDelayMs * 2^(attempt - 1)`).
- **Stale Fallback:** When all retry attempts fail and `serveStaleOnError` is enabled, any cached entry within its `staleGraceMs` window is served with `stale: true` and `source: "stale-cache"`, maintaining service availability during upstream outages.

### 4. Authorization Path
- **Mandatory Scope Isolation:** All entries require a `scope` (e.g. `PUBLIC_SCOPE` or `user:${actorId}`). Data stored in a viewer scope is completely inaccessible from another viewer scope.
- **Actor Authorization Validation:** `assertCacheScopeAuthorized(actor, scope)` verifies that unprivileged actors can only read and mutate their own user scope or the public scope. Unauthorized access throws `CacheAuthorizationError` (HTTP 403).
- **Scope Invalidation:** When user roles, permissions, or wallet credentials change, calling `cache.invalidateScope(scope)` purges all private cached data for that identity.

---

## Time and Space Complexity Design

| Operation | Time Complexity | Space Complexity |
|---|---|---|
| `lookup(key, { scope })` | $O(1)$ amortized map lookup + LRU reinsertion | $O(1)$ |
| `set(key, value, { scope })` | $O(1)$ insertion + $O(K)$ LRU evictions to fit bounds | $O(	ext{sizeOf}(value))$ bounded by `maxBytes` |
| `invalidate(key, { scope })` | $O(1)$ map deletion and tag index cleanup | $O(1)$ |
| `invalidateTag(tag)` | $O(T)$ where $T$ is keys associated with tag | $O(T)$ |
| `invalidateScope(scope)` | $O(N)$ where $N$ is total cached entries | $O(1)$ auxiliary |
| `findStale()` / `purgeStale()` | $O(N)$ scan of cached entries | $O(S)$ where $S$ is stale entries |
