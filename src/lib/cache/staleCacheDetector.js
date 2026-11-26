/**
 * src/lib/cache/staleCacheDetector.js
 *
 * Stale-cache detection with repair recommendations — Issue #1097.
 *
 * The bounded cache (`src/lib/cache/boundedCache.js`) already exposes a
 * non-mutating `snapshot()` for operator inspection and a `findStale()` audit
 * pass. This module turns that raw inspection data into an actionable,
 * authorization-gated repair plan:
 *
 *   - Detection is read-only. `detectStaleCache` / `buildStaleCacheReport`
 *     never mutate the cache or its counters.
 *   - Every finding carries a stable reason code, severity, and an explicit
 *     repair recommendation with ordered steps and a rollback description.
 *   - Applying a recommendation is a separate, opt-in step. `dryRun: true` is
 *     the default and only produces the plan; writes require `dryRun: false`,
 *     an explicit principal, and a successful `authorize(principal, action)`.
 *   - Transient repair failures are retried with exponential back-off;
 *     permanent failures (`retryable === false`) are surfaced immediately.
 *
 * No existing cache contract is changed: this module consumes `snapshot()`
 * output and adds new exports only.
 */

import crypto from 'node:crypto';

// ─── Constants ─────────────────────────────────────────────────────────────

export const STALE_REASON = Object.freeze({
  EXPIRED: 'EXPIRED',
  EXPIRED_PAST_GRACE: 'EXPIRED_PAST_GRACE',
  VERSION_BEHIND: 'VERSION_BEHIND',
  UNVERIFIED: 'UNVERIFIED',
  MISSING_VALUE: 'MISSING_VALUE',
});

export const REPAIR_ACTION = Object.freeze({
  REFRESH: 'REFRESH',
  PURGE_AND_REFILL: 'PURGE_AND_REFILL',
  INVALIDATE_AND_REFILL: 'INVALIDATE_AND_REFILL',
  VERIFY_SOURCE: 'VERIFY_SOURCE',
  REBUILD_FROM_SOURCE: 'REBUILD_FROM_SOURCE',
  NO_ACTION: 'NO_ACTION',
});

export const STALE_SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

// Tags whose staleness can affect money, access, or published state.
const CRITICAL_TAGS = new Set([
  'entitlement',
  'purchase',
  'checkout',
  'pricing',
  'permission',
  'auth',
  'critical',
]);

// ─── Errors ────────────────────────────────────────────────────────────────

export class StaleCacheAuthError extends Error {
  constructor(message = 'Not authorized to repair cache entries.') {
    super(message);
    this.name = 'StaleCacheAuthError';
    this.code = 'STALE_CACHE_AUTH_FORBIDDEN';
    this.status = 403;
  }
}

export class StaleCacheValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'StaleCacheValidationError';
    this.code = 'STALE_CACHE_VALIDATION_ERROR';
    this.status = 400;
    this.details = details;
  }
}

export class StaleCacheRepairError extends Error {
  constructor(message, { action, key, scope, attempts, cause } = {}) {
    super(message);
    this.name = 'StaleCacheRepairError';
    this.code = 'STALE_CACHE_REPAIR_FAILED';
    this.status = 502;
    this.action = action ?? null;
    this.key = key ?? null;
    this.scope = scope ?? null;
    this.attempts = attempts ?? null;
    this.cause = cause ?? null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isCritical(tokens) {
  return tokens.some((token) => {
    const value = String(token ?? '').toLowerCase();
    if (CRITICAL_TAGS.has(value)) return true;
    return [...CRITICAL_TAGS].some((tag) => value.includes(tag));
  });
}

function stableFingerprint(findings) {
  const normalized = findings
    .map((f) => ({
      scope: f.scope,
      key: f.key,
      reason: f.reason,
      action: f.recommendation?.action ?? null,
    }))
    .sort((a, b) => `${a.scope}:${a.key}:${a.reason}`.localeCompare(`${b.scope}:${b.key}:${b.reason}`));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// ─── Detection (read-only) ─────────────────────────────────────────────────

/**
 * Inspect cache snapshot entries and return deterministic staleness findings.
 *
 * @param {object}   options
 * @param {object}   [options.cache]            Object exposing `snapshot()` (e.g. createBoundedCache).
 * @param {Array}    [options.entries]          Explicit snapshot array; takes precedence over `cache`.
 * @param {Function} [options.versionFor]       (entry) => current source version.
 * @param {Function|number} [options.now]       Injectable clock.
 * @param {number}   [options.staleGraceMs=0]   Grace window after expiry.
 * @param {number}   [options.verificationTtlMs=null] Max age of `lastVerifiedAt` before UNVERIFIED.
 * @returns {Array<object>} findings
 */
export function detectStaleCache({
  cache = null,
  entries = null,
  versionFor = null,
  now = () => Date.now(),
  staleGraceMs = 0,
  verificationTtlMs = null,
} = {}) {
  const source = entries ?? (typeof cache?.snapshot === 'function' ? cache.snapshot() : null);
  if (!Array.isArray(source)) {
    throw new StaleCacheValidationError('entries must be an array or cache must expose snapshot().');
  }
  if (versionFor !== null && typeof versionFor !== 'function') {
    throw new StaleCacheValidationError('versionFor must be a function when provided.');
  }
  if (!Number.isFinite(staleGraceMs) || staleGraceMs < 0) {
    throw new StaleCacheValidationError('staleGraceMs must be a non-negative number.');
  }
  if (verificationTtlMs !== null && (!Number.isFinite(verificationTtlMs) || verificationTtlMs < 0)) {
    throw new StaleCacheValidationError('verificationTtlMs must be a non-negative number or null.');
  }

  const time = typeof now === 'function' ? Number(now()) : Number(now);
  if (!Number.isFinite(time)) {
    throw new StaleCacheValidationError('now must resolve to a finite number.');
  }

  const findings = [];

  for (const [index, raw] of source.entries()) {
    if (!raw || typeof raw !== 'object') {
      throw new StaleCacheValidationError(`Entry at index ${index} must be an object.`, { index });
    }
    if (typeof raw.key !== 'string' || !raw.key) {
      throw new StaleCacheValidationError(`Entry at index ${index} is missing a key.`, { index });
    }
    const scope = typeof raw.scope === 'string' && raw.scope ? raw.scope : 'public';
    const storedAt = Number.isFinite(raw.storedAt) ? raw.storedAt : time;
    const expiresAt = Number.isFinite(raw.expiresAt) ? raw.expiresAt : null;
    const tokens = [scope, raw.key, ...(Array.isArray(raw.tags) ? raw.tags : [])];

    // A missing value can never satisfy a read; it is the most severe case.
    if (raw.value === undefined || raw.value === null) {
      findings.push({
        scope,
        key: raw.key,
        reason: STALE_REASON.MISSING_VALUE,
        severity: STALE_SEVERITY.HIGH,
        ageMs: Math.max(0, time - storedAt),
        detail: 'Cached value is absent; reads will miss or fall back.',
        critical: isCritical(tokens),
        observedAt: time,
      });
      continue;
    }

    if (expiresAt !== null && time > expiresAt + staleGraceMs) {
      findings.push({
        scope,
        key: raw.key,
        reason: STALE_REASON.EXPIRED_PAST_GRACE,
        severity: STALE_SEVERITY.CRITICAL,
        ageMs: Math.max(0, time - storedAt),
        expiredForMs: time - expiresAt,
        detail: `Entry expired ${time - expiresAt}ms ago, beyond the ${staleGraceMs}ms grace window.`,
        critical: isCritical(tokens),
        observedAt: time,
      });
      continue;
    }

    if (expiresAt !== null && time > expiresAt) {
      findings.push({
        scope,
        key: raw.key,
        reason: STALE_REASON.EXPIRED,
        severity: STALE_SEVERITY.HIGH,
        ageMs: Math.max(0, time - storedAt),
        expiredForMs: time - expiresAt,
        detail: `Entry expired ${time - expiresAt}ms ago and is only being served from the grace window.`,
        critical: isCritical(tokens),
        observedAt: time,
      });
      continue;
    }

    const currentVersion = typeof versionFor === 'function' ? versionFor(raw) : undefined;
    if (currentVersion !== undefined && currentVersion !== raw.version) {
      findings.push({
        scope,
        key: raw.key,
        reason: STALE_REASON.VERSION_BEHIND,
        severity: isCritical(tokens) ? STALE_SEVERITY.CRITICAL : STALE_SEVERITY.HIGH,
        ageMs: Math.max(0, time - storedAt),
        cachedVersion: raw.version ?? null,
        currentVersion,
        detail: `Cached version ${String(raw.version ?? 'null')} differs from source version ${String(currentVersion)}.`,
        critical: isCritical(tokens),
        observedAt: time,
      });
      continue;
    }

    if (verificationTtlMs !== null && Number.isFinite(raw.lastVerifiedAt)) {
      const verificationAgeMs = time - raw.lastVerifiedAt;
      if (verificationAgeMs > verificationTtlMs) {
        findings.push({
          scope,
          key: raw.key,
          reason: STALE_REASON.UNVERIFIED,
          severity: STALE_SEVERITY.MEDIUM,
          ageMs: Math.max(0, time - storedAt),
          verificationAgeMs,
          detail: `Entry has not been verified against its source for ${verificationAgeMs}ms.`,
          critical: isCritical(tokens),
          observedAt: time,
        });
      }
    }
  }

  return findings;
}

// ─── Recommendations ───────────────────────────────────────────────────────

const REPAIR_PLAYBOOKS = {
  [STALE_REASON.MISSING_VALUE]: {
    action: REPAIR_ACTION.REBUILD_FROM_SOURCE,
    risk: STALE_SEVERITY.HIGH,
    retryable: true,
    steps: [
      'Acquire the source record for the cache key.',
      'Rebuild the cached projection and write it with the current source version.',
      'Confirm a follow-up read returns a non-empty value.',
    ],
    rollback: 'Invalidate the rebuilt key; readers fall back to a direct source read until the cache is repopulated.',
  },
  [STALE_REASON.EXPIRED_PAST_GRACE]: {
    action: REPAIR_ACTION.PURGE_AND_REFILL,
    risk: STALE_SEVERITY.CRITICAL,
    retryable: true,
    steps: [
      'Purge the expired entry and all dependent tagged entries.',
      'Reload the value from the authoritative source with a fresh TTL.',
      'Verify the replacement version matches the source before publishing.',
    ],
    rollback: 'If the refill fails, leave the key invalidated: reads fall through to the source rather than serving data past its grace window.',
  },
  [STALE_REASON.EXPIRED]: {
    action: REPAIR_ACTION.REFRESH,
    risk: STALE_SEVERITY.MEDIUM,
    retryable: true,
    steps: [
      'Revalidate the entry against the source.',
      'Refresh its TTL without changing the stored value when the source is unchanged.',
    ],
    rollback: 'Invalidate the key; the previous value is already inside its grace window and is safe to drop.',
  },
  [STALE_REASON.VERSION_BEHIND]: {
    action: REPAIR_ACTION.INVALIDATE_AND_REFILL,
    risk: STALE_SEVERITY.HIGH,
    retryable: true,
    steps: [
      'Invalidate the stale version by key and tags.',
      'Reload from the source with the current version.',
      'Reject a refill whose version still differs from the source (concurrent write drift).',
    ],
    rollback: 'Keep the key invalidated and retry on the next read; never serve a known-old version after a detected drift.',
  },
  [STALE_REASON.UNVERIFIED]: {
    action: REPAIR_ACTION.VERIFY_SOURCE,
    risk: STALE_SEVERITY.LOW,
    retryable: true,
    steps: [
      'Compare the cached fingerprint with the source fingerprint.',
      'Update lastVerifiedAt when they match; otherwise escalate to INVALIDATE_AND_REFILL.',
    ],
    rollback: 'No data change occurs when verification succeeds; on mismatch, invalidate the key.',
  },
};

/**
 * Build an explicit, human-readable repair recommendation for a finding.
 */
export function recommendRepair(finding, options = {}) {
  if (!finding || !STALE_REASON[finding.reason]) {
    throw new StaleCacheValidationError('Unknown stale-cache finding reason.');
  }
  const playbook = REPAIR_PLAYBOOKS[finding.reason];
  return {
    action: playbook.action,
    risk: finding.critical ? STALE_SEVERITY.CRITICAL : playbook.risk,
    retryable: playbook.retryable,
    requiresAuthorization: true,
    steps: [...playbook.steps],
    rollback: playbook.rollback,
    rationale: finding.detail,
    scope: finding.scope,
    key: finding.key,
    ...(options.notes ? { notes: String(options.notes) } : {}),
  };
}

/**
 * Produce a complete, deterministic operator report. Pure/read-only.
 */
export function buildStaleCacheReport(options = {}) {
  const findings = detectStaleCache(options);
  const items = findings.map((finding) => ({
    ...finding,
    recommendation: recommendRepair(finding, options),
  }));

  const summary = {
    total: items.length,
    byReason: Object.keys(STALE_REASON).reduce((acc, reason) => {
      acc[reason] = items.filter((item) => item.reason === reason).length;
      return acc;
    }, {}),
    bySeverity: Object.keys(STALE_SEVERITY).reduce((acc, severity) => {
      acc[severity] = items.filter((item) => item.severity === severity).length;
      return acc;
    }, {}),
    criticalKeys: items.filter((item) => item.critical).length,
  };

  const time = typeof options.now === 'function' ? Number(options.now()) : Number(options.now ?? Date.now());

  return {
    generatedAt: Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString(),
    dryRun: true,
    fingerprint: stableFingerprint(items),
    summary,
    findings: items,
  };
}

// ─── Repair application (authorization-gated, opt-in) ──────────────────────

/**
 * Create a repairer bound to an authorization gate and a repair handler.
 *
 * `repair({ action, scope, key, attempt, recommendation })` is the only code
 * that can mutate cache state. It is never called in dry-run mode or when the
 * authorization gate rejects the principal.
 */
export function createStaleCacheRepairer({
  authorize = async () => false,
  repair = async () => { throw new Error('No repair handler configured.'); },
  maxAttempts = 3,
  retryDelayMs = 25,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  if (typeof authorize !== 'function' || typeof repair !== 'function') {
    throw new StaleCacheValidationError('authorize and repair must be functions.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new StaleCacheValidationError('maxAttempts must be a positive integer.');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new StaleCacheValidationError('retryDelayMs must be non-negative.');
  }

  const stats = {
    previews: 0,
    applied: 0,
    rejected: 0,
    retries: 0,
    failed: 0,
  };

  /**
   * @param {object}  options
   * @param {object}  options.recommendation  From `recommendRepair` / report.
   * @param {object}  [options.principal]     Caller identity for authorize.
   * @param {boolean} [options.dryRun=true]   When true, no repair handler runs.
   * @param {string}  [options.reason]        Operator-supplied audit reason.
   */
  async function apply({ recommendation, principal = null, dryRun = true, reason = '' } = {}) {
    if (!recommendation || typeof recommendation !== 'object' || !recommendation.action) {
      throw new StaleCacheValidationError('A valid recommendation is required.');
    }

    // Authorization runs before the dry-run branch so unauthorized callers
    // cannot probe repair plans through a "harmless" preview.
    let allowed;
    try {
      allowed = await authorize(principal, recommendation);
    } catch {
      allowed = false;
    }
    if (allowed !== true) {
      stats.rejected += 1;
      throw new StaleCacheAuthError();
    }

    const plan = {
      action: recommendation.action,
      scope: recommendation.scope ?? 'public',
      key: recommendation.key ?? null,
      risk: recommendation.risk ?? null,
      rollback: recommendation.rollback ?? null,
      reason: String(reason || ''),
      dryRun: Boolean(dryRun),
    };

    if (dryRun) {
      stats.previews += 1;
      return { ...plan, applied: false, attempts: 0 };
    }

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await repair({
          ...plan,
          attempt,
          recommendation,
        });
        stats.applied += 1;
        return { ...plan, applied: true, attempts: attempt, result, repairedAt: new Date(now()).toISOString() };
      } catch (error) {
        lastError = error;
        if (error?.retryable === false || attempt === maxAttempts) break;
        stats.retries += 1;
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }

    stats.failed += 1;
    throw new StaleCacheRepairError(
      `Cache repair ${plan.action} failed for ${plan.scope}:${plan.key} after ${maxAttempts} attempt(s).`,
      {
        action: plan.action,
        key: plan.key,
        scope: plan.scope,
        attempts: maxAttempts,
        cause: lastError,
      },
    );
  }

  function getStats() {
    return { ...stats, configuredMaxAttempts: maxAttempts };
  }

  return { apply, stats: getStats };
}

// ─── Optional monitoring registry ──────────────────────────────────────────

// Caches that opt in by calling `registerCacheForMonitoring` become visible
// to the operator route. Registration is explicit so no cache is implicitly
// exposed through an HTTP endpoint, and unregistering is a no-op for unknown
// names. This registry is process-local and does not replace a real metrics
// backend.
const monitoredCaches = new Map();

export function registerCacheForMonitoring(name, cache) {
  if (typeof name !== 'string' || !name) {
    throw new StaleCacheValidationError('Cache name must be a non-empty string.');
  }
  if (!cache || typeof cache.snapshot !== 'function') {
    throw new StaleCacheValidationError('Registered cache must expose snapshot().');
  }
  monitoredCaches.set(name, cache);
  return true;
}

export function unregisterCache(name) {
  return monitoredCaches.delete(name);
}

export function getMonitoredCache(name) {
  return monitoredCaches.get(name) ?? null;
}

export function clearMonitoredCaches() {
  monitoredCaches.clear();
}

/**
 * Build a report across every registered cache without mutating any of them.
 * `versionFor` may be a function or a map keyed by registered cache name.
 */
export function buildRegisteredCacheReport({
  versionFor = null,
  now = () => Date.now(),
  staleGraceMs = 0,
  verificationTtlMs = null,
} = {}) {
  const allFindings = [];

  for (const [name, cache] of monitoredCaches.entries()) {
    const resolver = typeof versionFor === 'function'
      ? versionFor
      : (typeof versionFor === 'object' && versionFor !== null ? versionFor[name] : null);

    const findings = detectStaleCache({
      cache,
      versionFor: typeof resolver === 'function' ? resolver : null,
      now,
      staleGraceMs,
      verificationTtlMs,
    }).map((finding) => ({ ...finding, cacheName: name }));

    allFindings.push(...findings);
  }

  const items = allFindings.map((finding) => ({
    ...finding,
    recommendation: recommendRepair(finding),
  }));

  const summary = {
    total: items.length,
    cacheCount: monitoredCaches.size,
    byReason: Object.keys(STALE_REASON).reduce((acc, reason) => {
      acc[reason] = items.filter((item) => item.reason === reason).length;
      return acc;
    }, {}),
    bySeverity: Object.keys(STALE_SEVERITY).reduce((acc, severity) => {
      acc[severity] = items.filter((item) => item.severity === severity).length;
      return acc;
    }, {}),
    criticalKeys: items.filter((item) => item.critical).length,
  };

  const time = typeof now === 'function' ? Number(now()) : Number(now ?? Date.now());

  return {
    generatedAt: Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString(),
    dryRun: true,
    fingerprint: stableFingerprint(items),
    summary,
    findings: items,
  };
}
