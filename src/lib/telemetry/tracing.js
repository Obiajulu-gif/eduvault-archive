/**
 * OpenTelemetry-compatible tracing for EduVault (#20).
 *
 * Mirrors the pattern already used in src/lib/sentry.js:
 *  - Dynamically imports @opentelemetry/api so there's no build-time
 *    "Module not found" warning if it isn't installed.
 *  - Falls back to a lightweight local span implementation that keeps
 *    the exact same shape (traceId/spanId/attributes/status) so traces
 *    are testable locally and provider-agnostic.
 *
 * Usage:
 *   import { withSpan } from "@/lib/telemetry/tracing";
 *   await withSpan("purchase.checkout", { materialId }, async (span) => {
 *     ...
 *     span.setAttribute("outcome", "success");
 *   });
 */

import { getContext, generateSpanId } from "./context.js";
import { redactFields } from "./redact.js";
import { logger } from "../logger.js";

let _otelPromise = null;
const OTEL_API_MODULE = "@opentelemetry/api";

let _testDisableOtel = false;

export function disableOtelForTesting() {
  _testDisableOtel = true;
}

async function getOtel() {
  if (_testDisableOtel) return null;
  if (_otelPromise) return _otelPromise;
  _otelPromise = import(/* webpackIgnore: true */ /* @vite-ignore */ OTEL_API_MODULE).catch(
    () => null
  );
  return _otelPromise;
}

// In-memory buffer of recently completed spans — makes tracing testable
// locally without a real collector (acceptance criterion: "testable locally").
const RECENT_SPANS_LIMIT = 500;
export const recentSpans = [];

function recordLocalSpan(span) {
  recentSpans.push(span);
  if (recentSpans.length > RECENT_SPANS_LIMIT) recentSpans.shift();
}

/** Clear the local span buffer — used by tests between assertions. */
export function clearRecentSpans() {
  recentSpans.length = 0;
}

function makeLocalSpan(name, attributes) {
  const ctx = getContext();
  const spanId = generateSpanId();
  const startedAt = Date.now();
  const record = {
    name,
    traceId: ctx?.traceId || null,
    spanId,
    parentSpanId: ctx?.spanId || null,
    correlationId: ctx?.correlationId || null,
    attributes: redactFields(attributes),
    status: "unset",
    error: null,
    startedAt,
    durationMs: null,
  };

  return {
    _record: record,
    setAttribute(key, value) {
      record.attributes[key] = redactFields({ [key]: value })[key];
    },
    setStatus(status) {
      record.status = status;
    },
    recordException(error) {
      record.status = "error";
      record.error = String(error?.message || error);
    },
   end() {
      record.durationMs = Date.now() - startedAt;
      if (record.status === "unset") record.status = "ok";
      recordLocalSpan(record); // always kept locally — sampling only affects log noise, never dropped telemetry

      // Sampling (acceptance criterion): errors are always logged in full;
      // routine successful spans are sampled to control log volume/cost.
      // Configure via TELEMETRY_LOG_SAMPLE_RATE (0.0–1.0, default 1 = log all).
      const sampleRate = Number(process.env.TELEMETRY_LOG_SAMPLE_RATE ?? 1);
      const shouldLog = record.status === "error" || Math.random() < sampleRate;
      if (!shouldLog) return;

      logger.debug(
        {
          span: record.name,
          traceId: record.traceId,
          spanId: record.spanId,
          correlationId: record.correlationId,
          durationMs: record.durationMs,
          status: record.status,
          attributes: record.attributes,
        },
        "span completed"
      );
    },
  };
}

/**
 * Run `fn` inside a span named `name`. Works whether or not
 * @opentelemetry/api is installed.
 *
 * @param {string} name
 * @param {object} attributes - span attributes (PII is redacted)
 * @param {(span) => Promise<any>} fn
 */
export async function withSpan(name, attributes, fn) {
  const Otel = await getOtel();

  if (Otel) {
    const tracer = Otel.trace.getTracer("eduvault");
    return tracer.startActiveSpan(name, async (span) => {
      for (const [k, v] of Object.entries(redactFields(attributes))) {
        span.setAttribute(k, v);
      }
      try {
        const result = await fn(span);
        span.setStatus({ code: Otel.SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: Otel.SpanStatusCode.ERROR, message: String(error?.message || error) });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // No-op-but-real local fallback
  const span = makeLocalSpan(name, attributes);
  try {
    const result = await fn(span);
    span.setStatus("ok");
    return result;
  } catch (error) {
    span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
}
