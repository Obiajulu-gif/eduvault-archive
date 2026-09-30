import crypto from "node:crypto";

const CORRELATION_HEADER = "x-correlation-id";
const MAX_CORRELATION_ID_LENGTH = 64;

/**
 * Extracts the correlation ID from an incoming request header, or generates a
 * new one. Correlation IDs let support teams trace a failure across logs,
 * audit entries, and error responses without exposing internals.
 */
export function getCorrelationId(request) {
  if (request?.headers) {
    const headerValue = request.headers.get(CORRELATION_HEADER);
    if (headerValue) {
      const trimmed = headerValue.trim().slice(0, MAX_CORRELATION_ID_LENGTH);
      if (trimmed) return trimmed;
    }
  }
  return crypto.randomUUID();
}

export { CORRELATION_HEADER };
