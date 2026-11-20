/**
 * End-to-end request correlation ID propagation — Issue #1125
 *
 * Provides utilities to:
 * 1. Extract or generate a correlation ID from an incoming Next.js request.
 * 2. Inject it into outgoing fetch calls so downstream services receive it.
 * 3. Stamp it on all JSON responses via a response header.
 * 4. Propagate through retry loops with an attempt counter suffix.
 *
 * The correlation ID is threaded via AsyncLocalStorage when available, so
 * it survives multiple await boundaries within a single request handler
 * without passing it explicitly.
 */

import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const CORRELATION_HEADER = 'x-correlation-id';
export const ATTEMPT_HEADER = 'x-attempt';
const MAX_ID_LENGTH = 64;
const SAFE_ID_RE = /^[a-zA-Z0-9._:-]{1,64}$/;

const store = new AsyncLocalStorage();

/**
 * Extracts the correlation ID from request headers or generates a new one.
 * Rejects values that are too long or contain unsafe characters.
 *
 * @param {Request|Headers|object} requestOrHeaders
 * @returns {string}
 */
export function extractCorrelationId(requestOrHeaders) {
  let raw = null;
  if (requestOrHeaders) {
    const headers =
      typeof requestOrHeaders.headers?.get === 'function'
        ? requestOrHeaders.headers
        : requestOrHeaders;
    if (typeof headers.get === 'function') {
      raw = headers.get(CORRELATION_HEADER) ?? headers.get('x-request-id');
    } else if (typeof headers === 'object') {
      raw =
        headers[CORRELATION_HEADER] ??
        headers['x-request-id'] ??
        headers['X-Correlation-Id'] ??
        null;
    }
  }
  if (raw) {
    const trimmed = String(raw).trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH && SAFE_ID_RE.test(trimmed)) {
      return trimmed;
    }
  }
  return crypto.randomUUID();
}

/**
 * Returns the correlation ID bound to the current async context, or null.
 *
 * @returns {string|null}
 */
export function getCurrentCorrelationId() {
  return store.getStore()?.correlationId ?? null;
}

/**
 * Runs `fn` inside a context with the given correlationId available via
 * `getCurrentCorrelationId()`.
 *
 * @param {string} correlationId
 * @param {Function} fn
 * @returns {Promise<*>}
 */
export function runWithCorrelationId(correlationId, fn) {
  return store.run({ correlationId }, fn);
}

/**
 * Builds a Headers object (or plain object) that propagates the correlation
 * ID and an attempt counter to an outgoing fetch call.
 *
 * @param {object} [opts]
 * @param {string} [opts.correlationId] - Explicit ID; falls back to context store.
 * @param {number} [opts.attempt=1]
 * @param {Record<string,string>} [opts.extra] - Additional headers to merge.
 * @returns {Record<string, string>}
 */
export function buildPropagationHeaders({ correlationId, attempt = 1, extra = {} } = {}) {
  const id = correlationId ?? getCurrentCorrelationId() ?? crypto.randomUUID();
  return {
    [CORRELATION_HEADER]: id,
    [ATTEMPT_HEADER]: String(attempt),
    ...extra,
  };
}

/**
 * Wraps `fetch` to automatically inject the current correlation ID into
 * outgoing requests.
 *
 * @param {typeof fetch} [fetchImpl] - Defaults to global fetch.
 * @returns {typeof fetch}
 */
export function createCorrelatedFetch(fetchImpl = fetch) {
  return function correlatedFetch(input, init = {}) {
    const correlationId = getCurrentCorrelationId();
    if (!correlationId) return fetchImpl(input, init);

    const existingHeaders =
      init.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : (init.headers ?? {});

    const merged = {
      ...existingHeaders,
      [CORRELATION_HEADER]: existingHeaders[CORRELATION_HEADER] ?? correlationId,
    };

    return fetchImpl(input, { ...init, headers: merged });
  };
}

/**
 * Next.js Route Handler wrapper: extracts or generates a correlation ID,
 * binds it to the async context, and stamps it on the response.
 *
 * Usage in a route handler:
 *   export const GET = withCorrelation(async (req) => {
 *     const id = getCurrentCorrelationId();
 *     return Response.json({ id });
 *   });
 *
 * @param {Function} handler - (request: Request, correlationId: string) => Response|Promise<Response>
 * @returns {Function}
 */
export function withCorrelation(handler) {
  return async function correlationWrapper(request, ...rest) {
    const correlationId = extractCorrelationId(request);

    return runWithCorrelationId(correlationId, async () => {
      let response;
      try {
        response = await handler(request, correlationId, ...rest);
      } catch (err) {
        // Stamp correlation ID on error responses even when the handler throws
        const body = JSON.stringify({
          success: false,
          correlationId,
          error: { message: err?.message ?? 'Internal server error' },
        });
        response = new Response(body, {
          status: err?.status ?? 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Stamp correlation ID header on the response
      if (response instanceof Response) {
        const headers = new Headers(response.headers);
        if (!headers.has(CORRELATION_HEADER)) {
          headers.set(CORRELATION_HEADER, correlationId);
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return response;
    });
  };
}

/**
 * Retry helper that propagates the correlation ID and increments the attempt
 * counter on each retry.
 *
 * @param {Function} fn - (attempt: number, headers: object) => Promise<*>
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.delayMs=0]
 * @param {Function} [opts.isRetryable] - (error) => boolean
 * @returns {Promise<*>}
 */
export async function retryWithCorrelation(fn, { maxAttempts = 3, delayMs = 0, isRetryable = () => true } = {}) {
  const correlationId = getCurrentCorrelationId() ?? crypto.randomUUID();
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers = buildPropagationHeaders({ correlationId, attempt });
    try {
      return await fn(attempt, headers);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastError;
}
