import { AppError } from "../errors/AppError.js";

// Process-local cache with hard bounds, explicit invalidation and stale
// detection. It never grows past `maxEntries` / `maxBytes`, never serves one
// scope's entries to another, and never lets a load that raced an invalidation
// repopulate the cache with the old answer. See docs/bounded-cache.md.
//
// Entries are keyed by (scope, key). `scope` is mandatory: use PUBLIC_SCOPE for
// data anyone may read and a viewer id for anything permission-dependent.

export const PUBLIC_SCOPE = "public";

export const LookupStatus = Object.freeze({
  HIT: "hit",
  MISS: "miss",
  EXPIRED: "expired",
  STALE: "stale",
});

export class CacheAuthorizationError extends Error {
  constructor(message = "Unauthorized cache scope access.") {
    super(message);
    this.name = "CacheAuthorizationError";
    this.status = 403;
  }
}

export function assertCacheScopeAuthorized(actor, scope) {
  if (scope === PUBLIC_SCOPE) return true;
  if (!actor) {
    throw new CacheAuthorizationError("Actor identity is required to access non-public cache scope.");
  }
  if (actor.role === "admin" || actor.role === "service" || actor.role === "operator") {
    return true;
  }
  const actorId = actor.id || actor.sub || actor.walletAddress;
  const expectedScope = `user:${actorId}`;
  if (scope !== expectedScope) {
    throw new CacheAuthorizationError(`Actor is not authorized to access cache scope "${scope}".`);
  }
  return true;
}


const DEFAULTS = Object.freeze({
  maxEntries: 500,
  maxBytes: 8 * 1024 * 1024,
  defaultTtlMs: 30_000,
  staleGraceMs: 0,
});

const SEPARATOR = "\u0000";

function defaultSizeOf(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function validateName(value, field) {
  if (typeof value !== "string" || !value || value.includes(SEPARATOR) || value.length > 512) {
    throw new AppError("VALIDATION_FIELD", { message: `${field} must be a non-empty string.`, details: { field } });
  }
  return value;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {number} [options.maxEntries] hard cap on entries; least recently used goes first
 * @param {number} [options.maxBytes] hard cap on estimated payload size
 * @param {number} [options.defaultTtlMs]
 * @param {number} [options.staleGraceMs] how long past expiry an entry may still be served as a fallback when a reload fails
 * @param {boolean} [options.cloneValues] copy values in and out so callers cannot mutate cached data (default true)
 * @param {() => number} [options.now] clock, injectable for tests
 * @param {(value: any) => number} [options.sizeOf]
 * @param {(ms: number) => Promise<void>} [options.sleep] retry delay, injectable for tests
 */
export function createBoundedCache(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now;
  const sizeOf = options.sizeOf ?? defaultSizeOf;
  const sleep = options.sleep ?? defaultSleep;
  const cloneValues = options.cloneValues !== false;

  for (const field of ["maxEntries", "maxBytes", "defaultTtlMs"]) {
    if (!Number.isFinite(config[field]) || config[field] <= 0) {
      throw new AppError("VALIDATION_FIELD", { message: `${field} must be a positive number.`, details: { field } });
    }
  }
  if (!Number.isFinite(config.staleGraceMs) || config.staleGraceMs < 0) {
    throw new AppError("VALIDATION_FIELD", { message: "staleGraceMs must be zero or more.", details: { field: "staleGraceMs" } });
  }

  // Map iteration order is insertion order; re-inserting on access makes the first key the LRU one.
  const entries = new Map();
  const tagIndex = new Map();
  const inflight = new Map();
  let bytes = 0;
  // Bumped by every invalidation. A load that finishes under a different epoch is returned but not cached.
  let epoch = 0;
  const counters = {
    hits: 0, misses: 0, expired: 0, staleVersion: 0, staleServed: 0,
    evictions: 0, invalidations: 0, rejected: 0, loadFailures: 0, retries: 0,
  };

  const compose = (scope, key) => `${scope}${SEPARATOR}${key}`;
  const copy = (value) => (cloneValues ? structuredClone(value) : value);

  function remove(composite) {
    const entry = entries.get(composite);
    if (!entry) return false;
    entries.delete(composite);
    bytes -= entry.size;
    for (const tag of entry.tags) {
      const keys = tagIndex.get(tag);
      keys?.delete(composite);
      if (keys?.size === 0) tagIndex.delete(tag);
    }
    return true;
  }

  function evictToFit() {
    while (entries.size > config.maxEntries || bytes > config.maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      remove(oldest);
      counters.evictions += 1;
    }
  }

  function dropExpired(time) {
    for (const [composite, entry] of entries) {
      if (entry.expiresAt + config.staleGraceMs <= time) remove(composite);
    }
  }

  function invalidated(count) {
    epoch += 1;
    inflight.clear();
    counters.invalidations += count;
    return count;
  }

  /** Store a value. Returns false (and caches nothing) if it cannot be copied or could never fit. */
  function set(key, value, { scope, ttlMs, tags = [], version = null, actor } = {}) {
    if (actor) assertCacheScopeAuthorized(actor, scope);
    validateName(key, "key");
    validateName(scope, "scope");
    const ttl = ttlMs ?? config.defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new AppError("VALIDATION_FIELD", { message: "ttlMs must be a positive number.", details: { field: "ttlMs" } });
    }

    let stored;
    let size;
    try {
      stored = copy(value);
      size = sizeOf(value);
    } catch {
      counters.rejected += 1;
      return false;
    }
    if (size > config.maxBytes) {
      // Caching it would flush everything else; drop any older copy so it cannot be served as current.
      remove(compose(scope, key));
      counters.rejected += 1;
      return false;
    }

    const composite = compose(scope, key);
    remove(composite);
    const tagList = [...new Set(tags.map((tag) => validateName(tag, "tag")))];
    const time = now();
    entries.set(composite, {
      scope, key, value: stored, size, version, tags: tagList,
      storedAt: time, expiresAt: time + ttl,
    });
    bytes += size;
    for (const tag of tagList) {
      if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
      tagIndex.get(tag).add(composite);
    }
    dropExpired(time);
    evictToFit();
    return true;
  }

  /**
   * Look an entry up without side effects beyond LRU recency.
   * `version` is the caller's current version of the source data: an entry
   * stored under a different version is reported STALE and removed.
   */
  function lookup(key, { scope, version, actor } = {}) {
    if (actor) assertCacheScopeAuthorized(actor, scope);
    validateName(key, "key");
    validateName(scope, "scope");
    const composite = compose(scope, key);
    const entry = entries.get(composite);
    if (!entry) {
      counters.misses += 1;
      return { status: LookupStatus.MISS };
    }
    const time = now();
    if (version !== undefined && entry.version !== version) {
      remove(composite);
      counters.staleVersion += 1;
      return { status: LookupStatus.STALE, cachedVersion: entry.version, currentVersion: version };
    }
    if (entry.expiresAt <= time) {
      counters.expired += 1;
      if (entry.expiresAt + config.staleGraceMs <= time) remove(composite);
      return { status: LookupStatus.EXPIRED };
    }
    entries.delete(composite);
    entries.set(composite, entry);
    counters.hits += 1;
    return { status: LookupStatus.HIT, value: copy(entry.value), ageMs: time - entry.storedAt, version: entry.version };
  }

  function get(key, options) {
    const result = lookup(key, options);
    return result.status === LookupStatus.HIT ? result.value : undefined;
  }

  /** Expired-but-within-grace value, for use only as a fallback when the source is down. */
  function peekStale(key, { scope, version } = {}) {
    validateName(key, "key");
    validateName(scope, "scope");
    const entry = entries.get(compose(scope, key));
    if (!entry || (version !== undefined && entry.version !== version)) return undefined;
    const time = now();
    if (entry.expiresAt > time || entry.expiresAt + config.staleGraceMs <= time) return undefined;
    return { value: copy(entry.value), ageMs: time - entry.storedAt };
  }

  /**
   * Return the cached value or load it. Concurrent callers share one load.
   * A failed load is never cached; transient failures are retried, and if the
   * source stays down an entry still inside the stale grace window is served
   * (flagged `stale: true`) instead of failing the request.
   */
  async function getOrLoad(key, loader, { scope, ttlMs, tags, version, retries = 0, retryDelayMs = 50, serveStaleOnError = true } = {}) {
    const found = lookup(key, { scope, version });
    if (found.status === LookupStatus.HIT) return { value: found.value, source: "cache", stale: false };

    const composite = compose(scope, key);
    let flight = inflight.get(composite);
    if (!flight) {
      const startEpoch = epoch;
      flight = (async () => {
        let attempt = 0;
        for (;;) {
          try {
            const value = await loader();
            // Anything invalidated while we were loading may have changed the answer; hand it back but do not keep it.
            if (startEpoch === epoch) set(key, value, { scope, ttlMs, tags, version: version ?? null });
            return value;
          } catch (error) {
            if (attempt >= retries || error?.retryable === false) throw error;
            attempt += 1;
            counters.retries += 1;
            await sleep(retryDelayMs * 2 ** (attempt - 1));
          }
        }
      })().finally(() => {
        if (inflight.get(composite) === flight) inflight.delete(composite);
      });
      inflight.set(composite, flight);
    }

    try {
      return { value: copy(await flight), source: "loader", stale: false };
    } catch (error) {
      counters.loadFailures += 1;
      const fallback = serveStaleOnError ? peekStale(key, { scope, version }) : undefined;
      if (fallback) {
        counters.staleServed += 1;
        return { value: fallback.value, source: "stale-cache", stale: true, ageMs: fallback.ageMs };
      }
      throw error;
    }
  }

  // ── Explicit invalidation. Each returns the number of entries removed. ──

  function invalidate(key, { scope }) {
    validateName(key, "key");
    validateName(scope, "scope");
    return invalidated(remove(compose(scope, key)) ? 1 : 0);
  }

  /** Everything tagged `tag`, across scopes (e.g. `material:42` after the material changes). */
  function invalidateTag(tag) {
    validateName(tag, "tag");
    const keys = [...(tagIndex.get(tag) ?? [])];
    keys.forEach(remove);
    return invalidated(keys.length);
  }

  /** Everything cached for one scope, e.g. when a viewer's permissions or session change. */
  function invalidateScope(scope, { actor } = {}) {
    if (actor) assertCacheScopeAuthorized(actor, scope);
    validateName(scope, "scope");
    let removed = 0;
    for (const [composite, entry] of [...entries]) {
      if (entry.scope === scope && remove(composite)) removed += 1;
    }
    return invalidated(removed);
  }

  function invalidatePrefix(prefix, { scope } = {}) {
    validateName(prefix, "prefix");
    let removed = 0;
    for (const [composite, entry] of [...entries]) {
      if (entry.key.startsWith(prefix) && (scope === undefined || entry.scope === scope) && remove(composite)) removed += 1;
    }
    return invalidated(removed);
  }

  function clear() {
    const removed = entries.size;
    entries.clear();
    tagIndex.clear();
    bytes = 0;
    return invalidated(removed);
  }

  /**
   * Audit pass for operators: list entries that are expired past grace, or whose
   * stored version no longer matches `versionFor(entry)`. Does not mutate;
   * pass the result to purge, or call purgeStale.
   */
  function findStale({ versionFor } = {}) {
    const time = now();
    const findings = [];
    for (const entry of entries.values()) {
      if (entry.expiresAt + config.staleGraceMs <= time) {
        findings.push({ scope: entry.scope, key: entry.key, reason: "expired", ageMs: time - entry.storedAt });
        continue;
      }
      const current = versionFor?.(entry);
      if (current !== undefined && current !== entry.version) {
        findings.push({ scope: entry.scope, key: entry.key, reason: "version_behind", cachedVersion: entry.version, currentVersion: current });
      }
    }
    return findings;
  }

  function purgeStale(options) {
    const findings = findStale(options);
    let removed = 0;
    for (const finding of findings) if (remove(compose(finding.scope, finding.key))) removed += 1;
    if (removed) invalidated(removed);
    return { removed, findings };
  }

  /**
   * Non-mutating snapshot of current cache entries for reconciliation/inspection.
   * Does not update LRU order or hit/miss counters.
   */
  function snapshot({ scope } = {}) {
    if (scope !== undefined) validateName(scope, "scope");
    const items = [];
    for (const entry of entries.values()) {
      if (scope !== undefined && entry.scope !== scope) continue;
      items.push({
        scope: entry.scope,
        key: entry.key,
        value: copy(entry.value),
        version: entry.version,
        tags: [...entry.tags],
        storedAt: entry.storedAt,
        expiresAt: entry.expiresAt,
      });
    }
    return items;
  }

  function stats() {
    const lookups = counters.hits + counters.misses + counters.expired + counters.staleVersion;
    return {
      ...counters,
      size: entries.size,
      bytes,
      maxEntries: config.maxEntries,
      maxBytes: config.maxBytes,
      hitRate: lookups === 0 ? null : counters.hits / lookups,
    };
  }

  return { set, get, lookup, peekStale, getOrLoad, invalidate, invalidateTag, invalidateScope, invalidatePrefix, clear, findStale, purgeStale, snapshot, stats };
}
