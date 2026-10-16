/**
 * High-cardinality telemetry protection: label validation, cardinality
 * limiting, deterministic sampling, and structural bounds for log fields.
 *
 * Why this exists: log/metric backends index `operation`, `actorType`,
 * `result`, `metric` and `errorCode` as labels. If any of those can be fed by
 * user input (a request path, an id, an error message), an abusive client can
 * create unbounded label values and blow up storage/query cost or hide real
 * signals. This module keeps those dimensions to a small, safe set and keeps
 * dashboards truthful when volume is abusive.
 *
 * Design notes:
 * - Dependency-free and clock-injectable so behaviour is deterministic in
 *   tests. No timers: summaries are flushed opportunistically.
 * - Sampling is a token bucket (no randomness). Failures get a larger budget
 *   and a reserved slice of the global budget so a flood of successes cannot
 *   starve error visibility.
 * - Sampling never loses counts: dropped records are tallied per series and
 *   carried on the next kept record (`suppressed`) or in a periodic summary,
 *   so `kept + suppressed` always equals the true volume.
 * - Redaction of secret-shaped values lives in telemetry.js
 *   (`redactSensitive`); this module only bounds structure and shape.
 */

export const OVERFLOW_LABEL = "__overflow__";
export const INVALID_LABEL = "__invalid__";

/** Label keys that may be used as metric/log dimensions. Everything else is rejected. */
export const ALLOWED_LABEL_KEYS = Object.freeze([
  "operation",
  "actorType",
  "result",
  "metric",
  "metricType",
  "errorCode",
  "network",
  "status",
  "route",
  "method",
  "reason",
]);

/** Record fields treated as indexed dimensions by `process()`. */
export const DIMENSION_FIELDS = Object.freeze([
  "operation",
  "actorType",
  "result",
  "metric",
  "metricType",
  "errorCode",
]);

export const LABEL_REJECTION_REASONS = Object.freeze({
  KEY_NOT_ALLOWED: "key_not_allowed",
  HIGH_CARDINALITY_KEY: "high_cardinality_key",
  UNSUPPORTED_TYPE: "unsupported_type",
  TOO_LONG: "too_long",
  INVALID_CHARACTERS: "invalid_characters",
  LOOKS_LIKE_IDENTIFIER: "looks_like_identifier",
});

const MAX_LABEL_VALUE_LENGTH = 64;
const LABEL_VALUE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

// Keys that name per-entity values; never valid as a dimension.
const HIGH_CARDINALITY_KEY_PATTERN =
  /(^|[_.-])(user|wallet|account|session|token|email|ip|url|uri|path|query|address|hash|txid|ref)|(id|uuid|guid|hash|address)$/i;

// Value shapes that identify a single entity rather than a category.
const IDENTIFIER_SHAPES = Object.freeze([
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{16,}$/i, // ObjectId, tx hashes, digests
  /^[GSCMT][A-Z2-7]{55}$/, // Stellar strkeys
  /\d{9,}/, // long numeric runs (timestamps, account numbers)
  /^[A-Za-z0-9_-]{32,}$/, // opaque tokens
]);

export const DEFAULT_GUARD_CONFIG = Object.freeze({
  maxSeries: 500,
  maxErrorCodes: 100,
  idleMs: 10 * 60 * 1000,
  summaryIntervalMs: 30 * 1000,
  success: Object.freeze({ burst: 100, refillPerSec: 50 }),
  failure: Object.freeze({ burst: 300, refillPerSec: 150 }),
  global: Object.freeze({ burst: 2000, refillPerSec: 1000, failureReserveRatio: 0.2 }),
  fields: Object.freeze({ maxKeys: 40, maxArrayLength: 50, maxDepth: 5 }),
});

/**
 * Validate one label value.
 * @returns {{ok: true, value: string|number|boolean} | {ok: false, reason: string}}
 */
export function validateLabelValue(value) {
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: LABEL_REJECTION_REASONS.UNSUPPORTED_TYPE };
  } else if (type !== "string" && type !== "boolean") {
    return { ok: false, reason: LABEL_REJECTION_REASONS.UNSUPPORTED_TYPE };
  }

  const text = String(value);
  if (text.length > MAX_LABEL_VALUE_LENGTH) {
    return { ok: false, reason: LABEL_REJECTION_REASONS.TOO_LONG };
  }
  if (!LABEL_VALUE_PATTERN.test(text)) {
    return { ok: false, reason: LABEL_REJECTION_REASONS.INVALID_CHARACTERS };
  }
  if (IDENTIFIER_SHAPES.some((shape) => shape.test(text))) {
    return { ok: false, reason: LABEL_REJECTION_REASONS.LOOKS_LIKE_IDENTIFIER };
  }
  return { ok: true, value };
}

/**
 * Validate a free-form label set (e.g. caller-provided metric labels).
 * Unsafe keys/values are dropped and reported, never silently passed through.
 *
 * @returns {{labels: object, rejected: Array<{key: string, reason: string}>}}
 */
export function validateLabels(labels, allowedKeys = ALLOWED_LABEL_KEYS) {
  const safe = {};
  const rejected = [];
  if (labels == null || typeof labels !== "object") return { labels: safe, rejected };

  for (const key of Object.keys(labels)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      rejected.push({ key, reason: LABEL_REJECTION_REASONS.KEY_NOT_ALLOWED });
      continue;
    }
    if (HIGH_CARDINALITY_KEY_PATTERN.test(key)) {
      rejected.push({ key, reason: LABEL_REJECTION_REASONS.HIGH_CARDINALITY_KEY });
      continue;
    }
    if (!allowedKeys.includes(key)) {
      rejected.push({ key, reason: LABEL_REJECTION_REASONS.KEY_NOT_ALLOWED });
      continue;
    }
    const checked = validateLabelValue(labels[key]);
    if (!checked.ok) {
      rejected.push({ key, reason: checked.reason });
      continue;
    }
    safe[key] = checked.value;
  }
  return { labels: safe, rejected };
}

const FORBIDDEN_FIELD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_KEY_PATTERN = /^[A-Za-z0-9_.$-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f  ]/g;

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Bound the structure of a log/metadata payload so attacker-controlled input
 * cannot create unbounded keys, huge arrays, deep nesting, or forged log
 * lines. Strings keep their length here — truncation happens after redaction
 * so a secret is never cut into an unmatchable fragment.
 *
 * @returns {{value: any, dropped: {keys: number, items: number}}}
 */
export function boundFields(input, limits = DEFAULT_GUARD_CONFIG.fields) {
  const dropped = { keys: 0, items: 0 };

  const walk = (value, depth) => {
    if (typeof value === "string") return value.replace(CONTROL_CHARS, " ");
    if (value === null || typeof value !== "object") return value;
    if (depth >= limits.maxDepth) return "[TRUNCATED]";

    if (Array.isArray(value)) {
      const kept = value.slice(0, limits.maxArrayLength).map((entry) => walk(entry, depth + 1));
      if (value.length > limits.maxArrayLength) dropped.items += value.length - limits.maxArrayLength;
      return kept;
    }

    // Errors, Dates, mongoose docs etc. are handled by the redactor.
    if (!isPlainObject(value)) return value;

    const out = {};
    let kept = 0;
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_FIELD_KEYS.has(key) || !FIELD_KEY_PATTERN.test(key) || kept >= limits.maxKeys) {
        dropped.keys += 1;
        continue;
      }
      out[key] = walk(value[key], depth + 1);
      kept += 1;
    }
    return out;
  };

  return { value: walk(input, 0), dropped };
}

/**
 * Build a guard instance. The telemetry module owns a singleton; tests build
 * their own with an injected clock.
 */
export function createTelemetryGuard({ now = () => Date.now(), config: overrides = {} } = {}) {
  const config = {
    ...DEFAULT_GUARD_CONFIG,
    ...overrides,
    success: { ...DEFAULT_GUARD_CONFIG.success, ...overrides.success },
    failure: { ...DEFAULT_GUARD_CONFIG.failure, ...overrides.failure },
    global: { ...DEFAULT_GUARD_CONFIG.global, ...overrides.global },
    fields: { ...DEFAULT_GUARD_CONFIG.fields, ...overrides.fields },
  };

  const series = new Map(); // seriesKey -> entry
  const errorCodes = new Map(); // errorCode -> lastSeen
  const globalBucket = { tokens: config.global.burst, updated: now() };

  const stats = {
    accepted: 0,
    sampledOut: 0,
    overflowed: 0,
    lostSuppressed: 0,
    labelRejections: {},
    fieldsDropped: { keys: 0, items: 0 },
  };
  let lastSummaryAt = now();

  const countRejection = (reason) => {
    stats.labelRejections[reason] = (stats.labelRejections[reason] || 0) + 1;
  };

  function refill(bucket, { burst, refillPerSec }, t) {
    const elapsedSec = Math.max(0, (t - bucket.updated) / 1000);
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * refillPerSec);
    bucket.updated = t;
  }

  function evictIdle(map, t, onEvict) {
    for (const [key, value] of map) {
      const lastSeen = typeof value === "number" ? value : value.lastSeen;
      if (t - lastSeen >= config.idleMs) {
        if (onEvict) onEvict(value);
        map.delete(key);
      }
    }
  }

  function admitSeries(key, t) {
    let entry = series.get(key);
    if (entry) {
      entry.lastSeen = t;
      return entry;
    }
    // Overflow series are force-admitted: their key space is a handful of
    // fixed combinations, and they are what keeps excess volume counted.
    if (series.size >= config.maxSeries && !key.startsWith(OVERFLOW_LABEL)) {
      evictIdle(series, t, (evicted) => {
        stats.lostSuppressed += evicted.suppressedCount;
      });
      if (series.size >= config.maxSeries) return null;
    }
    entry = {
      lastSeen: t,
      total: 0,
      failures: 0,
      success: { tokens: config.success.burst, updated: t },
      failure: { tokens: config.failure.burst, updated: t },
      suppressedCount: 0,
      suppressedValue: 0,
    };
    series.set(key, entry);
    return entry;
  }

  function admitErrorCode(code, t) {
    if (errorCodes.has(code)) {
      errorCodes.set(code, t);
      return true;
    }
    if (errorCodes.size >= config.maxErrorCodes) {
      evictIdle(errorCodes, t);
      if (errorCodes.size >= config.maxErrorCodes) return false;
    }
    errorCodes.set(code, t);
    return true;
  }

  function sanitizeDimensions(record, t) {
    const next = { ...record };
    for (const field of DIMENSION_FIELDS) {
      if (next[field] === undefined || next[field] === null) continue;
      const checked = validateLabelValue(next[field]);
      if (!checked.ok) {
        countRejection(checked.reason);
        next[field] = INVALID_LABEL;
      }
    }
    if (next.errorCode !== undefined && next.errorCode !== INVALID_LABEL) {
      if (!admitErrorCode(String(next.errorCode), t)) {
        stats.overflowed += 1;
        next.errorCode = OVERFLOW_LABEL;
      }
    }
    return next;
  }

  function keepDecision(entry, isFailure, t) {
    const bucket = isFailure ? entry.failure : entry.success;
    refill(bucket, isFailure ? config.failure : config.success, t);
    refill(globalBucket, config.global, t);

    // Successes may not dip into the slice of the global budget held back for failures.
    const reserve = isFailure ? 0 : config.global.burst * config.global.failureReserveRatio;
    if (bucket.tokens < 1 || globalBucket.tokens < 1 + reserve) return false;

    bucket.tokens -= 1;
    globalBucket.tokens -= 1;
    return true;
  }

  /**
   * Apply label validation, cardinality limits, sampling, and field bounds.
   * @returns {{emit: boolean, record: object}}
   */
  function process(record) {
    const t = now();
    let next = sanitizeDimensions(record, t);

    for (const field of ["metadata", "error"]) {
      if (next[field] === undefined) continue;
      const bounded = boundFields(next[field], config.fields);
      stats.fieldsDropped.keys += bounded.dropped.keys;
      stats.fieldsDropped.items += bounded.dropped.items;
      next[field] = bounded.value;
    }

    const isFailure = next.result === "failure";
    const key = [next.operation, next.actorType, next.result, next.metric ?? ""].join("|");
    let entry = admitSeries(key, t);

    if (!entry) {
      // Too many distinct series: fold into a fixed overflow series instead of growing.
      stats.overflowed += 1;
      next = {
        ...next,
        operation: OVERFLOW_LABEL,
        actorType: OVERFLOW_LABEL,
        result: isFailure ? "failure" : "success",
        ...(next.metric !== undefined ? { metric: OVERFLOW_LABEL } : {}),
      };
      entry = admitSeries([OVERFLOW_LABEL, OVERFLOW_LABEL, next.result, next.metric ?? ""].join("|"), t);
    }

    const value = typeof next.value === "number" ? next.value : 0;
    entry.total += 1;
    if (isFailure) entry.failures += 1;

    if (!keepDecision(entry, isFailure, t)) {
      entry.suppressedCount += 1;
      entry.suppressedValue += value;
      stats.sampledOut += 1;
      return { emit: false, record: next };
    }

    stats.accepted += 1;
    if (entry.suppressedCount > 0) {
      next = { ...next, suppressed: { count: entry.suppressedCount, value: entry.suppressedValue } };
      entry.suppressedCount = 0;
      entry.suppressedValue = 0;
    }
    return { emit: true, record: next };
  }

  /** True when pending suppression should be reported as summaries. */
  function summaryDue() {
    return now() - lastSummaryAt >= config.summaryIntervalMs;
  }

  /** Drain per-series suppression tallies so they can be emitted as summary records. */
  function drainSummaries() {
    lastSummaryAt = now();
    const summaries = [];
    for (const [key, entry] of series) {
      if (entry.suppressedCount === 0) continue;
      const [operation, actorType, result, metric] = key.split("|");
      summaries.push({
        series: key,
        operation,
        actorType,
        result,
        ...(metric ? { metric } : {}),
        suppressedCount: entry.suppressedCount,
        suppressedValue: entry.suppressedValue,
      });
      entry.suppressedCount = 0;
      entry.suppressedValue = 0;
    }
    return summaries;
  }

  /** Exact (unsampled) counters; safe to expose on a health/metrics endpoint. */
  function getStats() {
    const seriesTotals = {};
    for (const [key, entry] of series) {
      seriesTotals[key] = {
        total: entry.total,
        failures: entry.failures,
        pendingSuppressed: entry.suppressedCount,
      };
    }
    return {
      ...stats,
      labelRejections: { ...stats.labelRejections },
      fieldsDropped: { ...stats.fieldsDropped },
      seriesCount: series.size,
      series: seriesTotals,
    };
  }

  function reset() {
    series.clear();
    errorCodes.clear();
    globalBucket.tokens = config.global.burst;
    globalBucket.updated = now();
    stats.accepted = 0;
    stats.sampledOut = 0;
    stats.overflowed = 0;
    stats.lostSuppressed = 0;
    stats.labelRejections = {};
    stats.fieldsDropped = { keys: 0, items: 0 };
    lastSummaryAt = now();
  }

  return { process, summaryDue, drainSummaries, getStats, reset, config };
}
