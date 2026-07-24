/**
 * Shared PII redaction rules for EduVault telemetry (#20).
 * Used by logger, tracing, and metrics so redaction is defined once.
 */

const DENY_FIELDS = new Set([
  "email",
  "password",
  "name",
  "phone",
  "address",
  "ip",
  "token",
  "authorization",
  "cookie",
  "secret",
  "privateKey",
  "jwt",
]);

/**
 * Wallet addresses are pseudonymous identifiers needed for debugging,
 * not personally identifiable information, so they are kept — but we
 * still truncate them for log noise reasons in some contexts.
 */
export function redactFields(obj = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (DENY_FIELDS.has(key.toLowerCase())) {
      safe[key] = "[REDACTED]";
    } else if (value !== undefined && value !== null) {
      safe[key] = value;
    }
  }
  return safe;
}

export function isDeniedField(key) {
  return DENY_FIELDS.has(String(key).toLowerCase());
}