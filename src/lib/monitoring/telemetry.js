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

function emitRecord(record) {
  const safe = redactSensitive(record);

  if (telemetrySink) {
    try {
      telemetrySink(safe);
    } catch (err) {
      // A broken sink must never break the instrumented operation.
      console.error("[telemetry] sink failed:", err);
    }
    return safe;
  }

  const level = safe.result === TELEMETRY_RESULT.FAILURE ? "error" : "info";
  logger[level]({ [TELEMETRY_LOG_NAMESPACE]: true, ...safe }, "telemetry");
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

function correlationIdFromRequest(request) {
  const headers = request?.headers;
  if (!headers || typeof headers.get !== "function") return undefined;
  const raw =
    headers.get("x-correlation-id") ||
    headers.get("x-request-id") ||
    headers.get("traceparent") ||
    undefined;
  if (!raw) return undefined;
  return String(raw).trim().slice(0, 128) || undefined;
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
  REDACTED,
  REQUIRED_TELEMETRY_FIELDS,
  TELEMETRY_LOG_NAMESPACE,
  TELEMETRY_RESULT,
  TELEMETRY_SCHEMA_VERSION,
  assertTelemetryRecord,
  ensureCorrelationId,
  getCorrelationId,
  recordMetric,
  redactSensitive,
  resetTelemetrySink,
  runWithCorrelationId,
  setTelemetrySink,
  validateTelemetryRecord,
  withTelemetry,
  withTelemetryRoute,
};

export default telemetry;
