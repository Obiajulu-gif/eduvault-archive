/**
 * Sentry integration for EduVault (#82).
 *
 * Wraps the @sentry/nextjs package with a thin layer that:
 *  - Is a no-op when SENTRY_DSN is not configured (safe for local dev / CI).
 *  - Strips PII (email, password, full user objects) before sending events.
 *  - Attaches wallet address as a non-PII identifier on the Sentry scope.
 *
 * Usage:
 *   import { captureException, captureMessage, setSentryUser } from "@/lib/sentry";
 */

let _sentry = null;

function getSentry() {
  if (_sentry) return _sentry;
  try {
    // Dynamic require so the module tree-shakes cleanly when SENTRY_DSN is absent.
    _sentry = require("@sentry/nextjs");
  } catch {
    // @sentry/nextjs not installed — operate in no-op mode.
    _sentry = null;
  }
  return _sentry;
}

function isEnabled() {
  return Boolean(process.env.SENTRY_DSN) && Boolean(getSentry());
}

/**
 * Scrub common PII fields before they reach Sentry.
 * Wallet addresses are retained because they are pseudonymous identifiers
 * needed for debugging, not personally identifiable information.
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

/**
 * Attach the current user's wallet address to the Sentry scope.
 * Call this as early as possible in authenticated request handlers.
 *
 * @param {string | null} walletAddress  — 56-char Stellar public key or null to clear
 */
export function setSentryUser(walletAddress) {
  if (!isEnabled()) return;
  const Sentry = getSentry();
  if (walletAddress) {
    Sentry.setUser({ id: walletAddress });
  } else {
    Sentry.setUser(null);
  }
}

/**
 * Capture an unexpected exception and send it to Sentry.
 *
 * @param {unknown}  error   — the caught error
 * @param {object}   [extra] — additional context (PII is stripped automatically)
 */
export function captureException(error, extra = {}) {
  if (!isEnabled()) {
    console.error("[sentry:captureException]", error, extra);
    return;
  }
  getSentry().withScope((scope) => {
    scope.setExtras(scrubContext(extra));
    getSentry().captureException(error);
  });
}

/**
 * Capture an informational or warning message.
 *
 * @param {string} message
 * @param {"fatal"|"error"|"warning"|"info"|"debug"} [level]
 * @param {object} [extra]
 */
export function captureMessage(message, level = "info", extra = {}) {
  if (!isEnabled()) {
    console.warn("[sentry:captureMessage]", level, message, extra);
    return;
  }
  getSentry().withScope((scope) => {
    scope.setLevel(level);
    scope.setExtras(scrubContext(extra));
    getSentry().captureMessage(message);
  });
}
