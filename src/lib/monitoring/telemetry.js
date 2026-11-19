/**
 * Structured telemetry for latency, failure rate, and business-critical
 * conversion points (issue #788).
 *
 * Design notes:
 * - Dependency-free: only Node built-ins (`node:crypto`, `node:async_hooks`)
 *   plus the repo's existing pino logger.
 * - Every emitted record carries a fixed, validated field set so dashboards
 *   and alerts can rely on it:
 *     operation, actorType, result, latencyMs, correlationId, timestamp,
 *     schemaVersion.
 * - Optional metadata is allow-listed through `redactSensitive()` — sensitive
 *   keys are dropped and known secret/token/email/hash shapes are masked.
 * - Raw request bodies are never logged by this module; callers pass only the
 *   specific, non-sensitive fields they want recorded.
 * - Emission goes through a replaceable sink. Production uses pino; tests use
 *   `setTelemetrySink()` to capture records in memory.
 */

import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import logger from "../logger.js";
import { hasPermission } from "../auth/permissions.js";
// logSafety.js imports this module too; the cycle is safe because neither
// module calls the other at load time.
import { maskIdentifiersInText, protectTelemetryFields } from "./logSafety.js";
import { boundFields, createTelemetryGuard, normalizeSampleRate, validateLabelValue } from "./telemetryGuard.js";

export const TELEMETRY_SCHEMA_VERSION = 1;

/** Marker mixed into every structured log line this module emits. */
export const TELEMETRY_LOG_NAMESPACE = "eduvault.telemetry";

/** Allowed outcome values for the fixed `result` field. */
export const TELEMETRY_RESULT = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
});

/** Actor classifications used across the instrumented operations. */
export const ACTOR_TYPES = Object.freeze({
  USER: "user",
  CREATOR: "creator",
  BUYER: "buyer",
  SYSTEM: "system",
  WORKER: "worker",
  SERVICE: "service",
  ANONYMOUS: "anonymous",
});

/**
 * The fixed field set every telemetry record must carry. Validation
 * (`validateTelemetryRecord`) asserts these are present and non-empty.
 */
export const REQUIRED_TELEMETRY_FIELDS = Object.freeze([
  "operation",
  "actorType",
  "result",
  "latencyMs",
  "correlationId",
  "timestamp",
  "schemaVersion",
]);

/**
 * Core operations instrumented for this issue. Kept here so the test suite
 * can assert coverage without importing every route module.
 */
export const CORE_OPERATIONS = Object.freeze([
  {
    operation: "purchase.complete",
    actorType: ACTOR_TYPES.USER,
    description: "Buyer completes or re-confirms a paid purchase",
  },
  {
    operation: "checkout.initiate",
    actorType: ACTOR_TYPES.USER,
    description: "Checkout intent creation (tax, trustline, discount)",
  },
  {
    operation: "material.upload",
    actorType: ACTOR_TYPES.CREATOR,
    description: "Creator uploads and pins a learning material",
  },
  {
    operation: "material.download",
    actorType: ACTOR_TYPES.USER,
    description: "Buyer requests a signed download capability",
  },
  {
    operation: "material.deliver",
    actorType: ACTOR_TYPES.USER,
    description: "Entitlement-checked material file delivery",
  },
  {
    operation: "wallet.fetch_balances",
    actorType: ACTOR_TYPES.USER,
    description: "Load a Stellar wallet balance snapshot",
  },
  {
    operation: "indexer.ingest",
    actorType: ACTOR_TYPES.SYSTEM,
    description: "Stellar indexer batch ingest",
  },
]);

export const REDACTED = "[REDACTED]";

// Keys whose *values* are always dropped, regardless of shape.
const SENSITIVE_KEY_PATTERN =
  /pass(word|phrase)?|secret|token|jwt|authorization|bearer|cookie|session|api[-_]?key|private[-_]?key|privatekey|seed|mnemonic|recovery[-_]?phrase|signature|signed[-_]?xdr|signedxdr|xdr|email|ssn|card[-_]?number|cvv|cvc/i;

// Value shapes masked wherever they appear, including free text.
const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  // Stellar secret seed (starts with S, 55 base32 chars follow).
  /\bS[A-Z2-7]{55}\b/g,
  // JWTs (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Bearer credentials.
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // Email addresses.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Full-length hex digests (e.g. private hashes); considered sensitive here.
  /\b[a-f0-9]{64}\b/gi,
]);

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 2048;

const correlationStorage = new AsyncLocalStorage();

let telemetrySink = null;

/**
 * Replace the emission target. Intended for tests and custom transports.
 * Pass `null` to restore pino logging.
 */
export function setTelemetrySink(sink) {
  telemetrySink = typeof sink === "function" ? sink : null;
}

export function resetTelemetrySink() {
  telemetrySink = null;
}

/** Current correlation id for the async context, if any. */
export function getCorrelationId() {
  return correlationStorage.getStore() || null;
}

/** Run `fn` with a correlation id bound to the async context. */
export function runWithCorrelationId(correlationId, fn) {
  return correlationStorage.run(correlationId || crypto.randomUUID(), fn);
}

/** Resolve a correlation id from an explicit value, context, or a new uuid. */
export function ensureCorrelationId(candidate) {
  return candidate || getCorrelationId() || crypto.randomUUID();
}

function maskString(value) {
  let masked = String(value);
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    masked = masked.replace(pattern, REDACTED);
  }
  if (masked.length > MAX_STRING_LENGTH) {
    masked = `${masked.slice(0, MAX_STRING_LENGTH)}…`;
  }
  return masked;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key));
}

/**
 * Recursively strip sensitive keys and mask sensitive value shapes.
 * Handles nested objects, arrays, Errors, and Dates. Never throws.
 */
export function redactSensitive(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return maskString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return REDACTED;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code ?? null,
      message: maskString(value.message || ""),
    };
  }

  if (depth >= MAX_DEPTH) return "[TRUNCATED]";

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, depth + 1));
  }

  const source = typeof value.toObject === "function" ? value.toObject() : value;
  const output = {};
  for (const [key, entry] of Object.entries(source)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redactSensitive(entry, depth + 1);
  }
  return output;
}

/**
 * Validate that a record carries the full fixed field set.
 * @returns {{valid: boolean, missing: string[]}}
 */
export function validateTelemetryRecord(record) {
  const missing = REQUIRED_TELEMETRY_FIELDS.filter((field) => {
    const value = record == null ? undefined : record[field];
    return value === undefined || value === null || value === "";
  });

  if (!missing.includes("result") && !Object.values(TELEMETRY_RESULT).includes(record.result)) {
    missing.push("result:invalid");
  }
  if (!missing.includes("latencyMs") && typeof record.latencyMs !== "number") {
    missing.push("latencyMs:invalid");
  }

  return { valid: missing.length === 0, missing };
}

/** Throwing form of `validateTelemetryRecord`, used by tests and guards. */
export function assertTelemetryRecord(record) {
  const { valid, missing } = validateTelemetryRecord(record);
  if (!valid) {
    throw new Error(`Invalid telemetry record — missing: ${missing.join(", ")}`);
  }
  return true;
}

/**
 * Telemetry guard singleton (label validation, cardinality limits, sampling).
 * Set `TELEMETRY_GUARD=off` to bypass it at runtime; redaction always applies.
 * `TELEMETRY_TRACE_SAMPLE_RATE` (0-1, default 1) enables trace-coherent head
 * sampling of successful records (#1086).
 */
function defaultGuardOptions() {
  return { config: { traceSampleRate: normalizeSampleRate(process.env.TELEMETRY_TRACE_SAMPLE_RATE) } };
}

let guard = createTelemetryGuard(defaultGuardOptions());

function guardEnabled() {
  return process.env.TELEMETRY_GUARD !== "off";
}

/**
 * Identifier pseudonymization of `metadata`/`error` before *any* sink (#1086).
 * Pino output was already protected by the logger hook, but custom sinks
 * (`setTelemetrySink`, exporters) received raw wallet addresses, user ids,
 * emails and IPs. `TELEMETRY_PSEUDONYMIZE=off` is the rollback switch; secret
 * redaction stays on regardless.
 */
function pseudonymizeEnabled() {
  return process.env.TELEMETRY_PSEUDONYMIZE !== "off";
}

function protectIdentifiers(record) {
  if (!pseudonymizeEnabled()) return record;
  const next = { ...record };
  if (next.metadata !== undefined) next.metadata = protectTelemetryFields(next.metadata);
  if (next.error !== undefined) next.error = protectTelemetryFields(next.error);
  return next;
}

/** Exact, unsampled counters plus label-rejection and overflow tallies. */
export function getTelemetryGuardStats() {
  return guard.getStats();
}

/** Rebuild the guard (tests, config changes). Accepts `createTelemetryGuard` options. */
export function resetTelemetryGuard(options) {
  guard = createTelemetryGuard(options ?? defaultGuardOptions());
  return guard;
}

/**
 * Bound and redact arbitrary log context (key count, key shape, array size,
 * control characters, secret shapes). Use for any log line that includes
 * request-derived fields.
 */
export function sanitizeLogFields(fields) {
  return redactSensitive(boundFields(fields).value);
}

function deliver(safe) {
  if (telemetrySink) {
    try {
      telemetrySink(safe);
    } catch (err) {
      // A broken sink must never break the instrumented operation.
      console.error("[telemetry] sink failed:", err);
    }
    return;
  }

  const level = safe.result === TELEMETRY_RESULT.FAILURE ? "error" : "info";
  logger[level]({ [TELEMETRY_LOG_NAMESPACE]: true, ...safe }, "telemetry");
}

function flushSuppressionSummaries() {
  for (const summary of guard.drainSummaries()) {
    deliver(
      redactSensitive({
        operation: "telemetry.suppressed_summary",
        actorType: ACTOR_TYPES.SYSTEM,
        result: TELEMETRY_RESULT.SUCCESS,
        latencyMs: 0,
        correlationId: ensureCorrelationId(),
        timestamp: new Date().toISOString(),
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        metric: "telemetry.suppressed",
        metricType: "counter",
        value: summary.suppressedCount,
        metadata: summary,
      })
    );
  }
}

/** Emit pending "records dropped by sampling" summaries immediately. */
export function flushTelemetrySummaries() {
  flushSuppressionSummaries();
}

/**
 * Returns the redacted record that was emitted, or `null` when sampling
 * dropped it (the drop is still counted and reported via `suppressed`).
 */
function emitRecord(record) {
  let prepared = record;
  if (guardEnabled()) {
    const decision = guard.process(record);
    if (guard.summaryDue()) flushSuppressionSummaries();
    if (!decision.emit) return null;
    prepared = decision.record;
  }

  const safe = redactSensitive(protectIdentifiers(prepared));
  deliver(safe);
  return safe;
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Wrap an async operation, measure its latency, and emit a success/failure
 * telemetry record. Re-throws any error from `fn` after emitting.
 *
 * @param {string} operation - Stable operation name (e.g. "purchase.complete").
 * @param {string} actorType - One of ACTOR_TYPES.
 * @param {() => any} fn - Async work to measure.
 * @param {object} [options]
 * @param {string} [options.correlationId] - Overrides the ambient/new id.
 * @param {object} [options.metadata] - Optional safe metadata (redacted).
 * @param {(result: any) => boolean} [options.isFailure] - Classifies a
 *   non-throwing result as a failure (e.g. HTTP status >= 400).
 * @param {string} [options.failureCode] - Code recorded for classified failures.
 */
export async function withTelemetry(operation, actorType, fn, options = {}) {
  if (typeof operation !== "string" || !operation) {
    throw new TypeError("withTelemetry requires a non-empty operation name");
  }
  if (typeof actorType !== "string" || !actorType) {
    throw new TypeError("withTelemetry requires a non-empty actorType");
  }
  if (typeof fn !== "function") {
    throw new TypeError("withTelemetry requires a function to measure");
  }

  const correlationId = ensureCorrelationId(options.correlationId);
  const startedAt = nowMs();

  const execute = async () => {
    try {
      const result = await fn();
      const latencyMs = roundMs(nowMs() - startedAt);
      const failed =
        typeof options.isFailure === "function" ? Boolean(options.isFailure(result)) : false;

      emitRecord({
        operation,
        actorType,
        result: failed ? TELEMETRY_RESULT.FAILURE : TELEMETRY_RESULT.SUCCESS,
        latencyMs,
        correlationId,
        timestamp: new Date().toISOString(),
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        ...(failed ? { errorCode: options.failureCode || "operation_failed" } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      });

      return result;
    } catch (error) {
      const latencyMs = roundMs(nowMs() - startedAt);

      emitRecord({
        operation,
        actorType,
        result: TELEMETRY_RESULT.FAILURE,
        latencyMs,
        correlationId,
        timestamp: new Date().toISOString(),
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        errorCode: options.failureCode || error?.code || "operation_error",
        error: {
          name: error?.name || "Error",
          code: error?.code ?? null,
          message: error?.message || String(error),
        },
        ...(options.metadata ? { metadata: options.metadata } : {}),
      });

      throw error;
    }
  };

  return getCorrelationId() ? execute() : correlationStorage.run(correlationId, execute);
}

/**
 * Emit a standalone metric/counter record using the same fixed field set.
 *
 * @param {string} name - Metric name (e.g. "conversion.purchase").
 * @param {object} [fields] - Optional safe metadata (redacted).
 * @param {object} [options]
 * @param {string} [options.operation] - Overrides the `operation` field.
 * @param {string} [options.actorType]
 * @param {string} [options.result]
 * @param {number} [options.latencyMs]
 * @param {string} [options.correlationId]
 * @param {number} [options.value] - Numeric value (defaults to 1).
 * @param {string} [options.metricType] - "counter" | "gauge" | "histogram".
 */
export function recordMetric(name, fields = {}, options = {}) {
  if (typeof name !== "string" || !name) {
    throw new TypeError("recordMetric requires a non-empty metric name");
  }

  return emitRecord({
    operation: options.operation || name,
    actorType: options.actorType || ACTOR_TYPES.SYSTEM,
    result: options.result || TELEMETRY_RESULT.SUCCESS,
    latencyMs: typeof options.latencyMs === "number" ? options.latencyMs : 0,
    correlationId: ensureCorrelationId(options.correlationId),
    timestamp: new Date().toISOString(),
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    metric: name,
    metricType: options.metricType || "counter",
    value: typeof options.value === "number" ? options.value : 1,
    metadata: fields,
  });
}

function defaultResponseIsFailure(response) {
  return Boolean(
    response && typeof response === "object" && typeof response.status === "number" && response.status >= 400
  );
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Accept a client-supplied correlation id only if it is a plain token (#1086).
 * It is echoed verbatim into every record of the request, so free text,
 * control characters, or a value carrying a wallet/email/IP would bypass
 * metadata pseudonymization. Rejected values get a fresh server-side id.
 */
export function normalizeCorrelationId(raw) {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!CORRELATION_ID_PATTERN.test(text)) return undefined;
  if (maskIdentifiersInText(text) !== text) return undefined;
  return text;
}

function correlationIdFromRequest(request) {
  const headers = request?.headers;
  if (!headers || typeof headers.get !== "function") return undefined;
  const raw =
    headers.get("x-correlation-id") ||
    headers.get("x-request-id") ||
    headers.get("traceparent") ||
    undefined;
  return normalizeCorrelationId(raw);
}

// ── Sampling overrides (#1086) ────────────────────────────────────────────

export const TELEMETRY_SAMPLING_PERMISSION = "telemetry:sampling:override";
export const MAX_SAMPLING_OVERRIDE_TTL_MS = 60 * 60 * 1000;
export const MIN_SAMPLING_OVERRIDE_TTL_MS = 1000;

const OVERRIDE_KEYS = new Set(["id", "operation", "correlationId", "rate", "ttlMs", "reason"]);
const OVERRIDE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export class TelemetryOverrideError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "TelemetryOverrideError";
    this.code = code;
    this.status = status;
  }
}

function overrideActorId(actor) {
  if (!actor || typeof actor !== "object") return null;
  const id = actor.id ?? actor.userId ?? null;
  return id === null || String(id).trim() === "" ? null : String(id);
}

function assertOverrideAuthorized(actor, authorize) {
  const allowed = typeof authorize === "function" ? authorize(actor) === true : hasPermission(actor, TELEMETRY_SAMPLING_PERMISSION);
  if (!allowed || !overrideActorId(actor)) {
    throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_FORBIDDEN", `Permission ${TELEMETRY_SAMPLING_PERMISSION} is required`, 403);
  }
}

function validateOverride(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_INVALID", "override must be an object");
  }
  const unknown = Object.keys(input).filter((key) => !OVERRIDE_KEYS.has(key));
  if (unknown.length > 0) {
    throw new TelemetryOverrideError(
      "TELEMETRY_OVERRIDE_INVALID",
      `Unsupported override field(s): ${unknown.join(", ")}. Only sampling can be overridden; redaction and label validation cannot be disabled.`
    );
  }
  if (typeof input.id !== "string" || !OVERRIDE_ID_PATTERN.test(input.id)) {
    throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_INVALID", "id must be 1-64 characters of [A-Za-z0-9_.:-]");
  }
  const hasOperation = input.operation !== undefined;
  const hasTrace = input.correlationId !== undefined;
  if (hasOperation === hasTrace) {
    throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_INVALID", "Exactly one of operation or correlationId is required");
  }
  if (hasOperation && !validateLabelValue(input.operation).ok) {
    throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_INVALID", "operation must be a valid low-cardinality label");
  }
  if (hasTrace && normalizeCorrelationId(input.correlationId) !== input.correlationId) {
    throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_INVALID", "correlationId must be a plain token without identifiers");
  }
  if (typeof input.rate !== "number" || !Number.isFinite(input.rate) || input.rate < 0 || input.rate > 1) {
    throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_INVALID", "rate must be a number between 0 and 1");
  }
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < MIN_SAMPLING_OVERRIDE_TTL_MS || input.ttlMs > MAX_SAMPLING_OVERRIDE_TTL_MS) {
    throw new TelemetryOverrideError(
      "TELEMETRY_OVERRIDE_INVALID",
      `ttlMs must be an integer between ${MIN_SAMPLING_OVERRIDE_TTL_MS} and ${MAX_SAMPLING_OVERRIDE_TTL_MS}`
    );
  }
  if (typeof input.reason !== "string" || !input.reason.trim()) {
    throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_INVALID", "reason is required");
  }
  return {
    id: input.id,
    ...(hasOperation ? { operation: input.operation } : { correlationId: input.correlationId }),
    rate: input.rate,
    ttlMs: input.ttlMs,
    reason: input.reason.trim().slice(0, 300),
  };
}

function defaultOverrideAudit(entry) {
  // Emitted unsampled (directly to the sink): an override must always leave a trace.
  deliver(
    redactSensitive(
      protectIdentifiers({
        operation: "telemetry.sampling_override",
        actorType: ACTOR_TYPES.SYSTEM,
        result: TELEMETRY_RESULT.SUCCESS,
        latencyMs: 0,
        correlationId: ensureCorrelationId(),
        timestamp: new Date().toISOString(),
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        metadata: entry,
      })
    )
  );
}

/**
 * Temporarily change head sampling for one operation or one trace, e.g. keep
 * every record of `checkout.quote` (rate 1) during an incident, or keep a
 * single user's trace while reproducing a bug. Requires
 * `telemetry:sampling:override`; expires after `ttlMs` (max 1 h); can never
 * touch redaction. Retrying with the same id and parameters is a no-op; the
 * same id with different parameters is a 409. The audit hook runs first and
 * fails closed.
 */
export async function applyTelemetrySamplingOverride({ actor, override, authorize, audit = defaultOverrideAudit, now = () => Date.now() } = {}) {
  assertOverrideAuthorized(actor, authorize);
  const valid = validateOverride(override);

  const existing = guard.getSamplingOverride(valid.id);
  if (existing) {
    const same =
      existing.operation === valid.operation &&
      existing.correlationId === valid.correlationId &&
      existing.rate === valid.rate &&
      existing.ttlMs === valid.ttlMs;
    if (!same) {
      throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_CONFLICT", `Override ${valid.id} already exists with different parameters`, 409);
    }
    return { status: "unchanged", override: existing };
  }
  if (guard.listSamplingOverrides().length >= guard.config.maxOverrides) {
    throw new TelemetryOverrideError("TELEMETRY_OVERRIDE_LIMIT", `At most ${guard.config.maxOverrides} sampling overrides may be active`, 429);
  }

  const stored = { ...valid, expiresAt: now() + valid.ttlMs, actor: overrideActorId(actor) };
  await audit({ action: "telemetry.sampling_override.applied", ...stored });
  return guard.setSamplingOverride(stored);
}

/** Remove an override before it expires. Removing a missing id is a no-op. */
export async function revokeTelemetrySamplingOverride({ actor, id, authorize, audit = defaultOverrideAudit } = {}) {
  assertOverrideAuthorized(actor, authorize);
  const existing = guard.getSamplingOverride(id);
  if (!existing) return { status: "absent" };
  await audit({ action: "telemetry.sampling_override.revoked", id, actor: overrideActorId(actor) });
  guard.clearSamplingOverride(id);
  return { status: "revoked" };
}

/** Active (unexpired) overrides; safe to expose to operators. */
export function listTelemetrySamplingOverrides() {
  return guard.listSamplingOverrides();
}

/**
 * Wrap a Next.js route handler so every request emits telemetry. Failures are
 * inferred from a status >= 400 response unless `options.isFailure` overrides.
 *
 * @param {string} operation
 * @param {string} actorType
 * @param {Function} handler - (request, context) => Response | Promise<Response>
 * @param {object} [options]
 */
export function withTelemetryRoute(operation, actorType, handler, options = {}) {
  const { isFailure, ...rest } = options;

  return function instrumentedRoute(request, context) {
    return withTelemetry(operation, actorType, () => handler(request, context), {
      correlationId: correlationIdFromRequest(request),
      ...rest,
      isFailure: isFailure || defaultResponseIsFailure,
    });
  };
}

const telemetry = {
  ACTOR_TYPES,
  CORE_OPERATIONS,
  applyTelemetrySamplingOverride,
  listTelemetrySamplingOverrides,
  normalizeCorrelationId,
  revokeTelemetrySamplingOverride,
  REDACTED,
  REQUIRED_TELEMETRY_FIELDS,
  TELEMETRY_LOG_NAMESPACE,
  TELEMETRY_RESULT,
  TELEMETRY_SCHEMA_VERSION,
  assertTelemetryRecord,
  ensureCorrelationId,
  flushTelemetrySummaries,
  getCorrelationId,
  getTelemetryGuardStats,
  recordMetric,
  redactSensitive,
  resetTelemetryGuard,
  resetTelemetrySink,
  sanitizeLogFields,
  runWithCorrelationId,
  setTelemetrySink,
  validateTelemetryRecord,
  withTelemetry,
  withTelemetryRoute,
};

export default telemetry;
