/**
 * End-to-end request correlation ID propagation (issue #1125).
 *
 * Extends the existing correlation-ID infrastructure in telemetry.js with:
 * - Next.js route middleware that reads an inbound ID and sets it on the
 *   response headers so callers can trace a request across hops.
 * - An outgoing-fetch wrapper that injects the ambient ID into every
 *   downstream HTTP call, so the ID propagates through service chains.
 * - A header-name registry so the whole codebase agrees on one constant.
 *
 * The ambient correlation ID is managed by AsyncLocalStorage in telemetry.js
 * (`runWithCorrelationId`, `getCorrelationId`). This module only handles the
 * HTTP boundary: reading the ID from inbound headers and writing it to
 * outbound ones.
 */

import crypto from "node:crypto";
import { ensureCorrelationId, getCorrelationId, runWithCorrelationId } from "../monitoring/telemetry.js";

/** HTTP header names this service reads/writes for correlation. */
export const CORRELATION_HEADERS = Object.freeze({
  /** Primary header — preferred for new service-to-service calls. */
  CORRELATION_ID: "x-correlation-id",
  /** Fallback header — honoured from inbound requests, not emitted outbound. */
  REQUEST_ID: "x-request-id",
  /** W3C traceparent — read-only; we extract the trace-id segment as a fallback. */
  TRACEPARENT: "traceparent",
});

const MAX_ID_LENGTH = 128;
const SAFE_ID_RE = /^[\w.\-:]{1,128}$/;

/**
 * Extract a correlation ID from an incoming request's headers.
 * Returns undefined when none of the known headers carry a valid value.
 *
 * @param {Headers|{get: (name: string) => string|null}} headers
 * @returns {string|undefined}
 */
export function extractCorrelationId(headers) {
  if (!headers || typeof headers.get !== "function") return undefined;

  for (const name of [
    CORRELATION_HEADERS.CORRELATION_ID,
    CORRELATION_HEADERS.REQUEST_ID,
  ]) {
    const value = headers.get(name);
    if (value) {
      const trimmed = String(value).trim().slice(0, MAX_ID_LENGTH);
      if (SAFE_ID_RE.test(trimmed)) return trimmed;
    }
  }

  // Parse the trace-id segment from a W3C traceparent: "00-<trace-id>-<span-id>-<flags>"
  const traceparent = headers.get(CORRELATION_HEADERS.TRACEPARENT);
  if (traceparent) {
    const parts = String(traceparent).split("-");
    if (parts.length >= 2 && parts[1] && SAFE_ID_RE.test(parts[1])) {
      return parts[1];
    }
  }

  return undefined;
}

/**
 * Generate a new, cryptographically random correlation ID.
 * @returns {string}
 */
export function generateCorrelationId() {
  return crypto.randomUUID();
}

/**
 * Build a Headers object (or plain object) with the correlation ID header set.
 *
 * @param {string} correlationId
 * @param {Record<string, string>} [base] - Existing headers to merge into.
 * @returns {Record<string, string>}
 */
export function correlationHeaders(correlationId, base = {}) {
  return {
    ...base,
    [CORRELATION_HEADERS.CORRELATION_ID]: correlationId,
  };
}

/**
 * Wrap a Next.js route handler to:
 * 1. Extract or generate a correlation ID for the request.
 * 2. Run the handler inside `runWithCorrelationId` so all downstream
 *    operations inherit the same ID.
 * 3. Add `x-correlation-id` to the response headers.
 *
 * @param {Function} handler - (request: Request, ctx?: any) => Response | Promise<Response>
 * @returns {Function} - Wrapped handler with the same signature.
 */
export function withCorrelationId(handler) {
  return async function correlatedHandler(request, ctx) {
    const inbound = extractCorrelationId(request?.headers);
    const correlationId = ensureCorrelationId(inbound);

    const response = await runWithCorrelationId(correlationId, () =>
      handler(request, ctx)
    );

    // Clone the response to inject the header; Response is immutable after creation.
    const headers = new Headers(response.headers);
    headers.set(CORRELATION_HEADERS.CORRELATION_ID, correlationId);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/**
 * A drop-in replacement for `fetch` that injects the ambient correlation ID
 * into every outgoing request. Falls back to `globalThis.fetch`.
 *
 * @param {string|URL|Request} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function correlatedFetch(input, init = {}) {
  const correlationId = getCorrelationId();
  if (!correlationId) {
    return globalThis.fetch(input, init);
  }

  const headers = new Headers(init.headers);
  if (!headers.has(CORRELATION_HEADERS.CORRELATION_ID)) {
    headers.set(CORRELATION_HEADERS.CORRELATION_ID, correlationId);
  }

  return globalThis.fetch(input, { ...init, headers });
}

/**
 * Build a fetch-compatible function that always propagates a given correlation
 * ID, regardless of the ambient async context (useful in workers and queues).
 *
 * @param {string} correlationId
 * @param {Function} [fetchImpl] - Custom fetch implementation (default: globalThis.fetch).
 * @returns {Function}
 */
export function createCorrelatedFetch(correlationId, fetchImpl = globalThis.fetch) {
  if (!correlationId) throw new TypeError("correlationId is required");
  return function boundFetch(input, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has(CORRELATION_HEADERS.CORRELATION_ID)) {
      headers.set(CORRELATION_HEADERS.CORRELATION_ID, correlationId);
    }
    return fetchImpl(input, { ...init, headers });
  };
}
