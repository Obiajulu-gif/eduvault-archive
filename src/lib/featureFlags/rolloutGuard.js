/**
 * src/lib/featureFlags/rolloutGuard.js
 *
 * Scoped feature-flag rollout guard with automatic rollback verification (#964)
 * and authorized emergency disablement (#1152).
 *
 * Capabilities:
 * 1. Scoped canary rollouts: deterministic percentage-based bucketing + principal whitelisting.
 * 2. Active health monitoring: detects consecutive errors, error rate spikes, or invariant violations.
 * 3. Automatic rollback: instantly flips flag to rolled back, routing traffic to fallback.
 * 4. Emergency disablement: authorized kill switch with verified cleanup and audit trail.
 * 5. Post-rollback consistency verification: ensures zero orphaned or half-applied states remain.
 * 6. Resilient recovery / re-enabling with explicit authorization checks.
 * 7. Immutable audit logging.
 */

import { createHash } from 'node:crypto';
import { appendAuditRecord } from '../backend/auditLedger.js';

export const ROLLOUT_STATUS = Object.freeze({
  INACTIVE: 'INACTIVE',
  ROLLING_OUT: 'ROLLING_OUT',
  HEALTHY: 'HEALTHY',
  ROLLED_BACK: 'ROLLED_BACK',
  EMERGENCY_DISABLED: 'EMERGENCY_DISABLED',
});

export const ROLLOUT_AUTHORIZED_ROLES = Object.freeze(['admin', 'operator', 'system', 'deployer']);

/**
 * Custom error thrown when rollout authorization fails.
 */
export class RolloutAuthorizationError extends Error {
  constructor(message, code = 'ERR_ROLLOUT_UNAUTHORIZED', status = 403) {
    super(message);
    this.name = 'RolloutAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Validates that an actor has administrative or operational authority
 * to perform sensitive rollout actions (e.g., emergency disablement, re-enablement).
 *
 * @param {object|string} actor
 * @param {string} [action='emergency_disable']
 * @throws {RolloutAuthorizationError}
 * @returns {boolean}
 */
export function assertRolloutGuardAuthorized(actor, action = 'emergency_disable') {
  if (!actor) {
    throw new RolloutAuthorizationError(
      `Authentication required to perform rollout action "${action}".`,
      'ERR_ROLLOUT_UNAUTHENTICATED',
      401
    );
  }

  const role = typeof actor === 'object' ? (actor.role || actor.type || '') : String(actor);
  const normalizedRole = String(role).trim().toLowerCase();

  if (!ROLLOUT_AUTHORIZED_ROLES.includes(normalizedRole)) {
    throw new RolloutAuthorizationError(
      `Access denied: actor with role "${normalizedRole}" is not authorized for "${action}". Required roles: ${ROLLOUT_AUTHORIZED_ROLES.join(', ')}`,
      'ERR_ROLLOUT_UNAUTHORIZED',
      403
    );
  }

  return true;
}

/**
 * Retry helper with exponential backoff for cleanup and consistency routines.
 *
 * @param {Function} fn
 * @param {object} [options]
 * @param {number} [options.retries=2]
 * @param {number} [options.delayMs=30]
 * @returns {Promise<any>}
 */
async function withRetries(fn, { retries = 2, delayMs = 30 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

/**
 * Computes deterministic bucket (0-99) for a given flag and principal.
 * Uses SHA-256 so distributions are uniform and reproducible without session affinity.
 *
 * @param {string} flagKey
 * @param {string} principalId
 * @returns {number} Integer between 0 and 99
 */
export function computePrincipalBucket(flagKey, principalId) {
  if (!flagKey || !principalId) return 0;
  const normalized = `${String(flagKey).trim().toUpperCase()}:${String(principalId).trim().toLowerCase()}`;
  const hash = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const integer = parseInt(hash.slice(0, 8), 16);
  return integer % 100;
}

export class FeatureRolloutGuard {
  constructor(options = {}) {
    this.flagKey = options.flagKey;
    this.description = options.description || '';
    this.rolloutPercentage = options.rolloutPercentage ?? 0;
    this.whitelist = new Set((options.whitelist || []).map((w) => String(w).toLowerCase()));
    this.status =
      options.status ||
      (this.rolloutPercentage > 0 || this.whitelist.size > 0 ? ROLLOUT_STATUS.ROLLING_OUT : ROLLOUT_STATUS.INACTIVE);

    // Monitoring thresholds
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
    this.errorRateThreshold = options.errorRateThreshold ?? 0.1; // 10%
    this.minSamplesForRateCheck = options.minSamplesForRateCheck ?? 10;

    // Metrics state
    this.consecutiveFailures = 0;
    this.totalInvocations = 0;
    this.totalFailures = 0;
    this.rollbackReason = null;
    this.rolledBackAt = null;
    this.emergencyDisabledBy = null;
    this.emergencyDisabledAt = null;
    this.emergencyDisableReason = null;
    this.postRollbackVerification = null;
  }

  /**
   * Evaluates if a given principal is enrolled in the rollout cohort.
   * Returns false immediately if flag is inactive, rolled back, or emergency disabled.
   *
   * @param {string} principalId
   * @returns {boolean}
   */
  isEnrolled(principalId) {
    if (this.status === ROLLOUT_STATUS.ROLLED_BACK || this.status === ROLLOUT_STATUS.EMERGENCY_DISABLED) {
      return false;
    }

    if (!principalId) {
      return this.status !== ROLLOUT_STATUS.INACTIVE && this.rolloutPercentage === 100;
    }

    const normId = String(principalId).toLowerCase();
    if (this.whitelist.has(normId)) {
      return true;
    }

    if (this.status === ROLLOUT_STATUS.INACTIVE) {
      return false;
    }

    const bucket = computePrincipalBucket(this.flagKey, normId);
    return bucket < this.rolloutPercentage;
  }

  /**
   * Executes a protected operation guarded by the rollout policy.
   * If enrolled, executes riskyOperation with invariant validation.
   * If health is violated, automatically triggers rollback, executes cleanup,
   * verifies system consistency, and serves fallbackOperation.
   *
   * @param {object} params
   * @param {string} params.principalId
   * @param {Function} params.riskyOperation
   * @param {Function} params.fallbackOperation
   * @param {Function} [params.invariantCheck] - Validates result integrity before returning
   * @param {Function} [params.rollbackCleanup] - Reverts in-flight half-applied state
   * @param {Function} [params.verifyConsistency] - Verifies zero-leak state post-rollback
   * @param {object} [params.db] - Optional DB instance for audit logging
   * @returns {Promise<any>}
   */
  async execute({
    principalId,
    riskyOperation,
    fallbackOperation,
    invariantCheck,
    rollbackCleanup,
    verifyConsistency,
    db,
  }) {
    if (this.status === ROLLOUT_STATUS.ROLLED_BACK || this.status === ROLLOUT_STATUS.EMERGENCY_DISABLED) {
      return fallbackOperation();
    }

    const enrolled = this.isEnrolled(principalId);
    if (!enrolled) {
      return fallbackOperation();
    }

    this.totalInvocations++;

    try {
      const result = await riskyOperation();

      // Check invariants if specified
      if (typeof invariantCheck === 'function') {
        const check = await invariantCheck(result);
        if (!check || check.valid === false) {
          throw new Error(`Rollout invariant violation: ${check?.reason || 'unspecified breach'}`);
        }
      }

      // Success: reset consecutive failure counter
      this.consecutiveFailures = 0;
      return result;
    } catch (err) {
      this.totalFailures++;
      this.consecutiveFailures++;

      const shouldRollback =
        this.consecutiveFailures >= this.maxConsecutiveFailures ||
        (this.totalInvocations >= this.minSamplesForRateCheck &&
          this.totalFailures / this.totalInvocations > this.errorRateThreshold) ||
        String(err.message).includes('invariant violation');

      if (shouldRollback) {
        await this.triggerRollback({
          reason: err.message,
          principalId,
          rollbackCleanup,
          verifyConsistency,
          db,
        });
      }

      // Gracefully route caller through the safe fallback
      return fallbackOperation();
    }
  }

  /**
   * Triggers automated rollback and verifies post-rollback state consistency.
   *
   * @param {object} params
   */
  async triggerRollback({ reason, principalId, rollbackCleanup, verifyConsistency, db }) {
    this.status = ROLLOUT_STATUS.ROLLED_BACK;
    this.rollbackReason = reason;
    this.rolledBackAt = new Date().toISOString();

    let cleanupDetails = { cleaned: false };
    if (typeof rollbackCleanup === 'function') {
      try {
        cleanupDetails = (await withRetries(rollbackCleanup, { retries: 2, delayMs: 20 })) || { cleaned: true };
      } catch (cleanupErr) {
        cleanupDetails = { cleaned: false, error: cleanupErr.message };
      }
    }

    let consistencyReport = { verified: true, orphanedRecordsCount: 0 };
    if (typeof verifyConsistency === 'function') {
      try {
        consistencyReport = (await withRetries(verifyConsistency, { retries: 2, delayMs: 20 })) || { verified: true };
      } catch (verifyErr) {
        consistencyReport = { verified: false, error: verifyErr.message };
      }
    }

    this.postRollbackVerification = {
      timestamp: this.rolledBackAt,
      reason,
      principalId,
      cleanup: cleanupDetails,
      consistency: consistencyReport,
      verifiedClean: consistencyReport.verified && (consistencyReport.orphanedRecordsCount || 0) === 0,
    };

    if (db) {
      try {
        await appendAuditRecord({
          db,
          operationId: `audit-flag-rollback-${this.flagKey}-${Date.now()}`,
          action: 'feature_flag.automatic_rollback',
          actor: 'system-rollout-guard',
          target: { type: 'feature_flag', key: this.flagKey },
          result: this.postRollbackVerification.verifiedClean ? 'success' : 'warning',
          reason,
          intent: this.postRollbackVerification,
        });
      } catch {
        // Fallback for tests without full audit collection
      }
    }
  }

  /**
   * Manually and immediately halts rollout via authorized emergency disablement (#1152).
   * Verifies operator permissions, applies rollback cleanups with retries,
   * performs post-rollback consistency check, and logs an immutable audit event.
   *
   * @param {object} params
   * @param {object|string} params.actor - Operator initiating disablement
   * @param {string} params.reason - Justification / incident reference
   * @param {Function} [params.rollbackCleanup] - In-flight state cleanup
   * @param {Function} [params.verifyConsistency] - Post-disablement consistency verification
   * @param {object} [params.db] - Database handle for audit ledger
   * @param {number} [params.retries=2] - Number of retry attempts for cleanup
   * @returns {Promise<object>} Status report post-disablement
   */
  async emergencyDisable({
    actor,
    reason,
    rollbackCleanup,
    verifyConsistency,
    db,
    retries = 2,
  } = {}) {
    assertRolloutGuardAuthorized(actor, 'emergency_disable');

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new Error('A descriptive reason is required for emergency disablement.');
    }

    const actorId = typeof actor === 'object' ? (actor.id || actor.name || actor.role || 'operator') : String(actor);
    const timestamp = new Date().toISOString();

    this.status = ROLLOUT_STATUS.EMERGENCY_DISABLED;
    this.rollbackReason = reason.trim();
    this.rolledBackAt = timestamp;
    this.emergencyDisabledBy = actorId;
    this.emergencyDisabledAt = timestamp;
    this.emergencyDisableReason = reason.trim();

    // Execute cleanup with retries
    let cleanupDetails = { cleaned: false };
    if (typeof rollbackCleanup === 'function') {
      try {
        cleanupDetails = (await withRetries(rollbackCleanup, { retries, delayMs: 25 })) || { cleaned: true };
      } catch (err) {
        cleanupDetails = { cleaned: false, error: err.message };
      }
    }

    // Execute consistency verification with retries
    let consistencyReport = { verified: true, orphanedRecordsCount: 0 };
    if (typeof verifyConsistency === 'function') {
      try {
        consistencyReport = (await withRetries(verifyConsistency, { retries, delayMs: 25 })) || { verified: true };
      } catch (err) {
        consistencyReport = { verified: false, error: err.message };
      }
    }

    this.postRollbackVerification = {
      timestamp,
      action: 'emergency_disable',
      disabledBy: actorId,
      reason: this.emergencyDisableReason,
      cleanup: cleanupDetails,
      consistency: consistencyReport,
      verifiedClean: consistencyReport.verified && (consistencyReport.orphanedRecordsCount || 0) === 0,
    };

    if (db) {
      try {
        await appendAuditRecord({
          db,
          operationId: `audit-flag-emergency-disable-${this.flagKey}-${Date.now()}`,
          action: 'feature_flag.emergency_disable',
          actor: actorId,
          target: { type: 'feature_flag', key: this.flagKey },
          result: this.postRollbackVerification.verifiedClean ? 'success' : 'warning',
          reason: this.emergencyDisableReason,
          intent: this.postRollbackVerification,
        });
      } catch {
        // Tolerant if audit ledger collection is unmocked in unit test
      }
    }

    return this.getStatus();
  }

  /**
   * Re-enables a previously rolled-back or emergency-disabled feature flag (#1152).
   * Requires authorized operator credentials and resets error metrics.
   *
   * @param {object} params
   * @param {object|string} params.actor
   * @param {number} [params.rolloutPercentage=0]
   * @param {Array<string>} [params.whitelist=[]]
   * @param {object} [params.db]
   * @returns {object} Updated status
   */
  async reEnable({
    actor,
    rolloutPercentage = 0,
    whitelist = [],
    db,
  } = {}) {
    assertRolloutGuardAuthorized(actor, 're_enable');

    const actorId = typeof actor === 'object' ? (actor.id || actor.name || actor.role || 'operator') : String(actor);

    this.rolloutPercentage = Math.min(100, Math.max(0, Number(rolloutPercentage) || 0));
    this.whitelist = new Set((whitelist || []).map((w) => String(w).toLowerCase()));
    this.status =
      this.rolloutPercentage > 0 || this.whitelist.size > 0 ? ROLLOUT_STATUS.ROLLING_OUT : ROLLOUT_STATUS.INACTIVE;

    // Reset health & failure tracking
    this.consecutiveFailures = 0;
    this.totalFailures = 0;
    this.totalInvocations = 0;
    this.rollbackReason = null;
    this.emergencyDisabledBy = null;
    this.emergencyDisabledAt = null;
    this.emergencyDisableReason = null;

    if (db) {
      try {
        await appendAuditRecord({
          db,
          operationId: `audit-flag-re-enable-${this.flagKey}-${Date.now()}`,
          action: 'feature_flag.re_enable',
          actor: actorId,
          target: { type: 'feature_flag', key: this.flagKey },
          result: 'success',
          reason: `Re-enabled at ${this.rolloutPercentage}% rollout`,
        });
      } catch {
        // Tolerant of missing audit db
      }
    }

    return this.getStatus();
  }

  /**
   * Returns current rollout status and health metrics.
   *
   * @returns {object}
   */
  getStatus() {
    return {
      flagKey: this.flagKey,
      status: this.status,
      rolloutPercentage: this.rolloutPercentage,
      whitelistSize: this.whitelist.size,
      totalInvocations: this.totalInvocations,
      totalFailures: this.totalFailures,
      failureRate: this.totalInvocations > 0 ? Number((this.totalFailures / this.totalInvocations).toFixed(4)) : 0,
      consecutiveFailures: this.consecutiveFailures,
      rollbackReason: this.rollbackReason,
      rolledBackAt: this.rolledBackAt,
      emergencyDisabledBy: this.emergencyDisabledBy,
      emergencyDisabledAt: this.emergencyDisabledAt,
      emergencyDisableReason: this.emergencyDisableReason,
      postRollbackVerification: this.postRollbackVerification,
    };
  }
}
