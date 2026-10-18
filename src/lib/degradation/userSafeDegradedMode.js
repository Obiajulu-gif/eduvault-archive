/**
 * User-Safe Degraded Mode Runtime for Unavailable Dependencies — Issue #988
 *
 * Provides a secure, zero-leakage degraded mode execution wrapper for all external
 * and infrastructure dependencies (Stellar Horizon, Pinata IPFS, MongoDB replicas,
 * Email/SMTP, and pricing oracles).
 *
 * Invariant Guarantees:
 * 1. Authorization Boundary Invariant: Authentication and authorization are enforced
 *    BEFORE evaluating dependency availability. Unauthorized requests are rejected immediately
 *    with 401/403 and NEVER masked by fallback behaviors.
 * 2. Zero Leakage Invariant: Internal topology, database connection strings, credentials,
 *    internal IPs, and stack traces are stripped before any response is exposed to users.
 * 3. Graceful Read-Only / Stale Cache Fallback: Tier-2 (content) operations return sanitized
 *    read-only cached content when available.
 * 4. Critical Financial Protection: Tier-1 mutations (purchases, balance transfers) are
 *    strictly blocked when their dependencies fail, preventing desynchronized state.
 * 5. Structured Diagnostics: Telemetry logs maintain non-sensitive diagnostic codes,
 *    retry-after headers, and degraded flags without exposing internal secrets.
 */

export const DEPENDENCY_STATE = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const DEGRADATION_SEVERITY = Object.freeze({
  CRITICAL_BLOCK: 'CRITICAL_BLOCK',
  READ_ONLY_FALLBACK: 'READ_ONLY_FALLBACK',
  CACHED_FALLBACK: 'CACHED_FALLBACK',
  QUEUED_RETRY: 'QUEUED_RETRY',
});

// In-memory dependency state and observability store
const dependencyRegistry = new Map();
const degradedModeEvents = [];
const MAX_EVENTS = 500;

/**
 * Patterns matching sensitive information that must NEVER leak to clients.
 */
const SENSITIVE_PATTERNS = [
  /mongodb(\+srv)?:\/\/[^\s"'<>]+/gi,
  /pinata[_-]?(api[_-]?key|secret[_-]?key)[=:\s"':]+[A-Za-z0-9_-]+/gi,
  /stellar[_-]?(secret|seed|key)[=:\s"':]+[A-Za-z0-9_-]+/gi,
  /bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bS[A-Z0-9]{55}\b/g, // Stellar secret seed
  /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.0\.0\.1|localhost)\b/gi,
  /\b[a-zA-Z0-9_-]+\.(internal|local|cluster\.local)\b/gi,
  /\s+at\s+.*\(.*\)/g, // Stack traces
  /\s+at\s+[^\n]+/g,
];

/**
 * Sanitizes an error message or object to ensure zero sensitive info is leaked.
 *
 * @param {Error|string|object} rawError
 * @param {string} [fallbackMessage]
 * @returns {string} Sanitized, user-safe message
 */
export function sanitizeForUser(rawError, fallbackMessage = 'The requested service is temporarily operating with limited capabilities.') {
  if (!rawError) return fallbackMessage;

  let message = typeof rawError === 'string' ? rawError : (rawError.message || String(rawError));

  for (const pattern of SENSITIVE_PATTERNS) {
    message = message.replace(pattern, '[REDACTED]');
  }

  // Prevent generic database or system driver raw messages
  if (
    message.includes('MongoError') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('HorizonError') ||
    message.includes('PoolClosed') ||
    message.includes('[REDACTED]')
  ) {
    return fallbackMessage;
  }

  return message;
}

/**
 * Validates authentication and authorization before any degradation evaluation.
 * Enforces the Authorization Boundary Invariant.
 *
 * @param {object} authContext
 * @param {string|string[]} [requiredPermissions]
 */
export function validateAuthBoundary(authContext, requiredPermissions) {
  if (!authContext || authContext.isAuthenticated !== true) {
    const error = new Error('Authentication required to access this resource.');
    error.status = 401;
    error.code = 'UNAUTHENTICATED';
    error.isAuthBoundaryError = true;
    throw error;
  }

  if (requiredPermissions) {
    const permissions = Array.isArray(requiredPermissions) ? requiredPermissions : [requiredPermissions];
    const userPermissions = new Set(authContext.permissions || []);

    const hasAll = permissions.every((perm) => userPermissions.has(perm) || userPermissions.has('*'));
    if (!hasAll) {
      const error = new Error('You do not have permission to perform this action.');
      error.status = 403;
      error.code = 'FORBIDDEN';
      error.isAuthBoundaryError = true;
      throw error;
    }
  }

  return true;
}

/**
 * Registers or updates a dependency health state.
 *
 * @param {string} dependency
 * @param {'HEALTHY'|'DEGRADED'|'UNAVAILABLE'} state
 * @param {object} [metadata]
 */
export function setDependencyHealth(dependency, state, metadata = {}) {
  const normState = state?.toUpperCase();
  if (!DEPENDENCY_STATE[normState]) {
    throw new Error(`Invalid dependency state: ${state}`);
  }

  const prev = dependencyRegistry.get(dependency);
  const now = new Date();

  dependencyRegistry.set(dependency, {
    state: normState,
    lastUpdated: now,
    consecutiveFailures: normState === DEPENDENCY_STATE.HEALTHY ? 0 : ((prev?.consecutiveFailures || 0) + 1),
    metadata: { ...metadata },
  });

  recordDegradedModeEvent({
    event: 'DEPENDENCY_STATE_CHANGED',
    dependency,
    fromState: prev?.state || 'UNKNOWN',
    toState: normState,
    timestamp: now.toISOString(),
  });
}

/**
 * Retrieves the current health state of a dependency.
 *
 * @param {string} dependency
 * @returns {{ state: string, consecutiveFailures: number, lastUpdated: Date, metadata: object }}
 */
export function getDependencyHealth(dependency) {
  return dependencyRegistry.get(dependency) || {
    state: DEPENDENCY_STATE.HEALTHY,
    consecutiveFailures: 0,
    lastUpdated: new Date(),
    metadata: {},
  };
}

/**
 * Resets dependency state (for tests).
 */
export function resetDependencyRegistry() {
  dependencyRegistry.clear();
  degradedModeEvents.length = 0;
}

/**
 * Internal event recording for observability.
 */
function recordDegradedModeEvent(event) {
  degradedModeEvents.push(event);
  if (degradedModeEvents.length > MAX_EVENTS) {
    degradedModeEvents.shift();
  }
}

/**
 * Gets degraded mode observability events.
 */
export function getDegradedModeEvents() {
  return [...degradedModeEvents];
}

/**
 * Main wrapper executing an operation under user-safe degraded mode.
 *
 * @param {object} options
 * @param {string} options.dependency - Dependency name ('stellar', 'pinata', 'mongodb', etc.)
 * @param {string} options.operation - Operation name ('fetchMetadata', 'executePurchase', etc.)
 * @param {object} [options.authContext] - User auth context { isAuthenticated, userId, permissions }
 * @param {string|string[]} [options.requiredPermissions] - Permissions to enforce
 * @param {Function} options.actionFn - Async primary operation
 * @param {Function} [options.fallbackFn] - Async fallback operation when degraded
 * @param {boolean} [options.isCriticalFinancial=false] - If true, blocks mutations on failure
 * @param {number} [options.maxRetries=2] - Maximum retry attempts before fallback
 * @param {number} [options.retryBackoffMs=20] - Exponential retry backoff in ms
 * @param {any} [options.cachedData] - Pre-cached fallback data
 * @param {number} [options.retryAfterSeconds=30] - Recommended client retry interval
 * @returns {Promise<object>} Result payload
 */
export async function executeWithUserSafeDegradation({
  dependency,
  operation,
  authContext = null,
  requiredPermissions = null,
  actionFn,
  fallbackFn = null,
  isCriticalFinancial = false,
  maxRetries = 2,
  retryBackoffMs = 20,
  cachedData = null,
  retryAfterSeconds = 30,
}) {
  // Step 1: Enforce Authorization Boundary Invariant FIRST
  if (authContext !== null) {
    validateAuthBoundary(authContext, requiredPermissions);
  }

  const currentHealth = getDependencyHealth(dependency);

  // Step 2: If dependency is known to be UNAVAILABLE
  if (currentHealth.state === DEPENDENCY_STATE.UNAVAILABLE) {
    if (isCriticalFinancial) {
      recordDegradedModeEvent({
        event: 'CRITICAL_OPERATION_BLOCKED',
        dependency,
        operation,
        reason: 'Dependency unavailable for critical financial mutation',
        timestamp: new Date().toISOString(),
      });

      return {
        success: false,
        degraded: true,
        blocked: true,
        dependency,
        operation,
        code: 'DEPENDENCY_UNAVAILABLE_CRITICAL_BLOCKED',
        error: `The ${dependency} service is currently unavailable. To protect transaction integrity, this operation cannot proceed.`,
        retryAfter: retryAfterSeconds,
        userGuidance: 'Please retry in a few moments once network services stabilize.',
      };
    }

    // Non-critical: serve fallback if provided
    if (typeof fallbackFn === 'function') {
      const fallbackResult = await fallbackFn({
        dependency,
        operation,
        reason: 'DEPENDENCY_UNAVAILABLE',
        cachedData,
      });

      recordDegradedModeEvent({
        event: 'FALLBACK_SERVED',
        dependency,
        operation,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        degraded: true,
        readOnly: true,
        data: fallbackResult,
        warning: `Viewing cached or degraded view. Some dynamic features of ${dependency} are temporarily offline.`,
        retryAfter: retryAfterSeconds,
      };
    }

    if (cachedData !== null) {
      return {
        success: true,
        degraded: true,
        readOnly: true,
        data: cachedData,
        warning: 'Serving cached snapshot while dependency is unavailable.',
        retryAfter: retryAfterSeconds,
      };
    }

    return {
      success: false,
      degraded: true,
      dependency,
      operation,
      code: 'DEPENDENCY_UNAVAILABLE',
      error: `The requested ${dependency} feature is currently offline for maintenance.`,
      retryAfter: retryAfterSeconds,
    };
  }

  // Step 3: Attempt primary execution with retries
  let lastError;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const result = await actionFn();

      // If previous failures occurred, record health recovery
      if (currentHealth.consecutiveFailures > 0) {
        setDependencyHealth(dependency, DEPENDENCY_STATE.HEALTHY);
      }

      return {
        success: true,
        degraded: false,
        data: result,
      };
    } catch (err) {
      lastError = err;
      attempt++;

      // Do NOT retry authorization or invariant boundary errors
      if (err.isAuthBoundaryError || err.isInvariantViolation) {
        throw err;
      }

      if (attempt <= maxRetries) {
        const backoff = retryBackoffMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  // Step 4: Retries exhausted — transition dependency to DEGRADED / UNAVAILABLE
  const newFailures = (currentHealth.consecutiveFailures || 0) + 1;
  const nextState = newFailures >= 3 ? DEPENDENCY_STATE.UNAVAILABLE : DEPENDENCY_STATE.DEGRADED;
  setDependencyHealth(dependency, nextState, { lastError: sanitizeForUser(lastError) });

  recordDegradedModeEvent({
    event: 'DEPENDENCY_CALL_FAILED_EXHAUSTED',
    dependency,
    operation,
    attempts: attempt,
    nextState,
    timestamp: new Date().toISOString(),
  });

  // Step 5: For critical financial operations, strictly BLOCK
  if (isCriticalFinancial) {
    return {
      success: false,
      degraded: true,
      blocked: true,
      dependency,
      operation,
      code: 'DEPENDENCY_FAILURE_CRITICAL_BLOCKED',
      error: sanitizeForUser(lastError, `Unable to safely complete ${operation} due to temporary ${dependency} outage.`),
      retryAfter: retryAfterSeconds,
      userGuidance: 'Your balances and resources remain safe. Please retry shortly.',
    };
  }

  // Step 6: Non-critical operations serve safe fallback
  if (typeof fallbackFn === 'function') {
    const fallbackResult = await fallbackFn({
      dependency,
      operation,
      reason: 'RETRY_EXHAUSTION',
      cachedData,
    });

    return {
      success: true,
      degraded: true,
      readOnly: true,
      data: fallbackResult,
      warning: sanitizeForUser(lastError, `Operating in degraded mode for ${dependency}.`),
      retryAfter: retryAfterSeconds,
    };
  }

  if (cachedData !== null) {
    return {
      success: true,
      degraded: true,
      readOnly: true,
      data: cachedData,
      warning: 'Serving cached snapshot while dependency recovers.',
      retryAfter: retryAfterSeconds,
    };
  }

  // Final user-safe failure response
  return {
    success: false,
    degraded: true,
    dependency,
    operation,
    code: 'DEPENDENCY_DEGRADED',
    error: sanitizeForUser(lastError, `The ${dependency} service is temporarily degraded. Please try again later.`),
    retryAfter: retryAfterSeconds,
  };
}
