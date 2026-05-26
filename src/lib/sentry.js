/**
 * Lightweight Sentry compatibility helpers for EduVault.
 *
 * The production app can wire a real Sentry SDK in a future milestone, but
 * the build should not fail when the optional package is absent. These
 * wrappers keep the current API surface intact while falling back to console
 * logging in local and CI environments.
 */

function scrubContext(extra = {}) {
  const DENY = new Set(["email", "password", "name", "phone", "address", "ip"]);
  const safe = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!DENY.has(key.toLowerCase())) {
      safe[key] = value;
    }
  }
  return safe;
}

export function setSentryUser(walletAddress) {
  if (!walletAddress) return;
}

export function captureException(error, extra = {}) {
  const context = scrubContext(extra);
  console.error("[sentry:captureException]", error, context);
}

export function captureMessage(message, level = "info", extra = {}) {
  const context = scrubContext(extra);
  console.warn("[sentry:captureMessage]", level, message, context);
}
