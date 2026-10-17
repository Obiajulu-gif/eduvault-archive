import crypto from "node:crypto";

const CORRELATION_HEADER = "x-correlation-id";
const MAX_CORRELATION_ID_LENGTH = 64;
const SAFE_CORRELATION_ID = /^[a-zA-Z0-9._:-]{1,64}$/;

/**
 * Extracts the correlation ID from an incoming request header, or generates a
 * new one. Correlation IDs let support teams trace a failure across logs,
 * audit entries, and error responses without exposing internals.
 */
export function getCorrelationId(request) {
  if (request?.headers) {
    const headerValue = request.headers.get(CORRELATION_HEADER);
    if (headerValue) {
      const trimmed = headerValue.trim();
      if (trimmed.length <= MAX_CORRELATION_ID_LENGTH && SAFE_CORRELATION_ID.test(trimmed)) {
        return trimmed;
      }
    }
  }
  return crypto.randomUUID();
}

export { CORRELATION_HEADER };
