/**
 * Source-of-truth vs cached state reconciliation (#1073).
 *
 * Reconciles authoritative source records (e.g. MongoDB / service loader)
 * against a live cache store (`createBoundedCache` or any compatible cache
 * adapter implementing `snapshot`, `set`, and `invalidate`).
 *
 * Design guarantees:
 * - Dry-run-first: `dryRun` defaults to `true`; zero cache mutations occur.
 * - Authorization-checked: rejects unauthorized actors before reading or
 *   repairing scoped cache state.
 * - Retry-resilient: transient cache/source errors are retried with bounded
 *   backoff (`maxRetries`, `retryDelayMs`) before recording an item failure.
 * - Rollback-capable: captures pre-repair cache entries so a repair batch can
 *   be reverted via `rollbackCacheRepairs` if downstream verification fails.
 */

import { AppError } from "../errors/AppError.js";
import { PUBLIC_SCOPE } from "../cache/boundedCache.js";

export const CACHE_DRIFT_CATEGORY = Object.freeze({
  MISSING_IN_CACHE: "MISSING_IN_CACHE",
  STALE_VERSION: "STALE_VERSION",
  VALUE_DIVERGENCE: "VALUE_DIVERGENCE",
  ORPHAN_IN_CACHE: "ORPHAN_IN_CACHE",
  EXPIRED_IN_CACHE: "EXPIRED_IN_CACHE",
  SCOPE_LEAK: "SCOPE_LEAK",
});

export const CACHE_REPAIR_ACTION = Object.freeze({
  SET_CACHE: "SET_CACHE",
  REFRESH_CACHE: "REFRESH_CACHE",
  INVALIDATE_CACHE: "INVALIDATE_CACHE",
});

export const DEFAULT_AUTHORIZED_ROLES = Object.freeze(["admin", "operator", "system"]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Verifies that `actor` is authorized to inspect or repair cached state.
 * Fails closed on missing or non-privileged actors.
 */
export function authorizeCacheReconciliation({ actor, scope, authorizedRoles = DEFAULT_AUTHORIZED_ROLES, authorize } = {}) {
  if (typeof authorize === "function") {
    const allowed = authorize({ actor, scope });
    if (!allowed) {
      throw new AppError("AUTH_FORBIDDEN", {
        message: "Actor is not authorized to reconcile cached state.",
        details: { scope: scope ?? "all" },
      });
    }
    return;
  }

  const role = typeof actor === "string" ? actor : actor?.role;
  if (!role || !authorizedRoles.includes(role)) {
    throw new AppError("AUTH_FORBIDDEN", {
      message: "Insufficient role for source-to-cache reconciliation.",
      details: { role: role ?? null, requiredRoles: authorizedRoles },
    });
  }
}

async function withRetries(fn, { maxRetries = 2, retryDelayMs = 10, sleep = defaultSleep } = {}) {
  let attempts = 0;
  let lastError;
  while (attempts <= maxRetries) {
    try {
      const value = await fn(attempts);
      return { value, retries: attempts };
    } catch (error) {
      lastError = error;
      if (attempts >= maxRetries) break;
      attempts += 1;
      if (retryDelayMs > 0) await sleep(retryDelayMs * attempts);
    }
  }
  const err = lastError instanceof Error ? lastError : new Error(String(lastError));
  err.retriesAttempted = attempts;
  throw err;
}

/**
 * Restores cache entries to their pre-repair state using a snapshot captured
 * during `reconcileSourceAndCache`.
 *
 * @param {object} cache - Cache instance with `set` and `invalidate`
 * @param {Array<object>} rollbackEntries - Entries from `report.rollbackSnapshot`
 * @returns {{ restoredCount: number, invalidatedCount: number }}
 */
export function rollbackCacheRepairs(cache, rollbackEntries = []) {
  let restoredCount = 0;
  let invalidatedCount = 0;

  for (const entry of rollbackEntries) {
    if (entry.existedBefore) {
      cache.set(entry.key, entry.value, {
        scope: entry.scope,
        version: entry.version ?? null,
        tags: entry.tags ?? [],
      });
      restoredCount += 1;
    } else {
      invalidatedCount += cache.invalidate(entry.key, { scope: entry.scope });
    }
  }

  return { restoredCount, invalidatedCount };
}

/**
 * Reconciles authoritative source records against cached state.
 *
 * Source records must provide `{ key, value, scope?, version?, tags?, ttlMs?, isPublic? }`.
 *
 * @param {object} params
 * @param {() => Promise<Array<object>>|Array<object>} params.loadSourceRecords
 * @param {object} params.cache - Cache instance (`snapshot`, `set`, `invalidate`)
 * @param {object|string} [params.actor='system']
 * @param {string} [params.scope] - Optional scope filter
 * @param {boolean} [params.dryRun=true]
 * @param {number} [params.maxRetries=2]
 * @param {number} [params.retryDelayMs=10]
 * @param {() => number} [params.now=Date.now]
 * @param {(ms: number) => Promise<void>} [params.sleep]
 * @param {(ctx: { actor: any, scope?: string }) => boolean} [params.authorize]
 * @param {(event: object) => Promise<void>|void} [params.auditSink]
 */
export async function reconcileSourceAndCache({
  loadSourceRecords,
  cache,
  actor,
  scope,
  dryRun = true,
  maxRetries = 2,
  retryDelayMs = 10,
  now = Date.now,
  sleep = defaultSleep,
  authorize,
  auditSink,
} = {}) {
  authorizeCacheReconciliation({ actor, scope, authorize });

  if (typeof loadSourceRecords !== "function") {
    throw new AppError("VALIDATION_FIELD", { message: "loadSourceRecords must be a function." });
  }
  if (!cache || typeof cache.snapshot !== "function" || typeof cache.set !== "function" || typeof cache.invalidate !== "function") {
    throw new AppError("VALIDATION_FIELD", { message: "cache must implement snapshot, set, and invalidate." });
  }

  let retriesUsed = 0;
  const sourceLoad = await withRetries(() => Promise.resolve(loadSourceRecords()), {
    maxRetries,
    retryDelayMs,
    sleep,
  });
  retriesUsed += sourceLoad.retries;

  const sourceRecords = Array.isArray(sourceLoad.value) ? sourceLoad.value : [];
  const cachedEntries = cache.snapshot(scope !== undefined ? { scope } : undefined);
  const currentTime = now();

  const sourceByComposite = new Map();
  const sourceByKey = new Map();
  for (const record of sourceRecords) {
    const recScope = record.scope ?? PUBLIC_SCOPE;
    if (scope !== undefined && recScope !== scope) continue;
    const composite = `${recScope}\u0000${record.key}`;
    sourceByComposite.set(composite, { ...record, scope: recScope });
    sourceByKey.set(record.key, { ...record, scope: recScope });
  }

  const cacheByComposite = new Map();
  for (const entry of cachedEntries) {
    const composite = `${entry.scope}\u0000${entry.key}`;
    cacheByComposite.set(composite, entry);
  }

  const driftItems = [];

  // 1. Check source records against cache
  for (const [composite, src] of sourceByComposite.entries()) {
    const cached = cacheByComposite.get(composite);
    if (!cached) {
      driftItems.push({
        scope: src.scope,
        key: src.key,
        category: CACHE_DRIFT_CATEGORY.MISSING_IN_CACHE,
        plannedAction: CACHE_REPAIR_ACTION.SET_CACHE,
        sourceVersion: src.version ?? null,
        cachedVersion: null,
        sourceRecord: src,
      });
      continue;
    }

    if (cached.expiresAt !== undefined && cached.expiresAt <= currentTime) {
      driftItems.push({
        scope: src.scope,
        key: src.key,
        category: CACHE_DRIFT_CATEGORY.EXPIRED_IN_CACHE,
        plannedAction: CACHE_REPAIR_ACTION.REFRESH_CACHE,
        sourceVersion: src.version ?? null,
        cachedVersion: cached.version ?? null,
        sourceRecord: src,
      });
      continue;
    }

    if (src.version !== undefined && src.version !== cached.version) {
      driftItems.push({
        scope: src.scope,
        key: src.key,
        category: CACHE_DRIFT_CATEGORY.STALE_VERSION,
        plannedAction: CACHE_REPAIR_ACTION.REFRESH_CACHE,
        sourceVersion: src.version,
        cachedVersion: cached.version ?? null,
        sourceRecord: src,
      });
      continue;
    }

    if (stableStringify(src.value) !== stableStringify(cached.value)) {
      driftItems.push({
        scope: src.scope,
        key: src.key,
        category: CACHE_DRIFT_CATEGORY.VALUE_DIVERGENCE,
        plannedAction: CACHE_REPAIR_ACTION.REFRESH_CACHE,
        sourceVersion: src.version ?? null,
        cachedVersion: cached.version ?? null,
        sourceRecord: src,
      });
    }
  }

  // 2. Check cached entries for orphans or scope leaks
  for (const [composite, cached] of cacheByComposite.entries()) {
    if (sourceByComposite.has(composite)) continue;

    // Detect if a non-public source record leaked into PUBLIC_SCOPE
    const matchingSource = sourceByKey.get(cached.key);
    const isScopeLeak = cached.scope === PUBLIC_SCOPE && matchingSource && matchingSource.scope !== PUBLIC_SCOPE;

    driftItems.push({
      scope: cached.scope,
      key: cached.key,
      category: isScopeLeak ? CACHE_DRIFT_CATEGORY.SCOPE_LEAK : CACHE_DRIFT_CATEGORY.ORPHAN_IN_CACHE,
      plannedAction: CACHE_REPAIR_ACTION.INVALIDATE_CACHE,
      sourceVersion: matchingSource?.version ?? null,
      cachedVersion: cached.version ?? null,
      sourceRecord: null,
    });
  }

  const byCategory = Object.fromEntries(
    Object.values(CACHE_DRIFT_CATEGORY).map((cat) => [cat, driftItems.filter((d) => d.category === cat).length])
  );

  const report = {
    timestamp: new Date(currentTime).toISOString(),
    scope: scope ?? "all",
    dryRun,
    driftCount: driftItems.length,
    byCategory,
    driftItems,
    repairedCount: 0,
    errorsCount: 0,
    retriedCount: retriesUsed,
    failedItems: [],
    rollbackSnapshot: [],
  };

  if (dryRun || driftItems.length === 0) {
    return report;
  }

  // Capture pre-repair state for rollback before mutating
  for (const item of driftItems) {
    const composite = `${item.scope}\u0000${item.key}`;
    const prev = cacheByComposite.get(composite);
    report.rollbackSnapshot.push(
      prev
        ? {
            existedBefore: true,
            scope: prev.scope,
            key: prev.key,
            value: prev.value,
            version: prev.version,
            tags: prev.tags,
          }
        : {
            existedBefore: false,
            scope: item.scope,
            key: item.key,
          }
    );
  }

  // Apply repairs with per-item retry so one failure does not abort healthy items
  for (const item of driftItems) {
    try {
      const repairResult = await withRetries(
        () => {
          if (item.plannedAction === CACHE_REPAIR_ACTION.INVALIDATE_CACHE) {
            cache.invalidate(item.key, { scope: item.scope });
            return true;
          }
          const ok = cache.set(item.key, item.sourceRecord.value, {
            scope: item.scope,
            version: item.sourceRecord.version ?? null,
            tags: item.sourceRecord.tags ?? [],
            ttlMs: item.sourceRecord.ttlMs,
          });
          if (!ok) {
            throw new Error(`Cache rejected value for ${item.scope}:${item.key}`);
          }
          return true;
        },
        { maxRetries, retryDelayMs, sleep }
      );
      report.retriedCount += repairResult.retries;
      report.repairedCount += 1;
    } catch (error) {
      report.retriedCount += error.retriesAttempted ?? 0;
      report.errorsCount += 1;
      report.failedItems.push({
        scope: item.scope,
        key: item.key,
        category: item.category,
        error: error.message,
      });
    }
  }

  if (typeof auditSink === "function") {
    await auditSink({
      action: "reconciliation.source_cache_repaired",
      actor: typeof actor === "string" ? actor : actor?.id ?? actor?.role ?? "unknown",
      scope: report.scope,
      driftCount: report.driftCount,
      repairedCount: report.repairedCount,
      errorsCount: report.errorsCount,
      timestamp: report.timestamp,
    });
  }

  return report;
}
