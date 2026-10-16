/**
 * src/lib/release/releaseReadiness.js
 *
 * Release Readiness Engine for Eduvault Archive (#1022).
 * Verifies database migrations, executes pre-release smoke tests,
 * validates rollback rehearsal states, and enforces deployment authorization.
 */

export const CheckStatus = Object.freeze({
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  WARNING: 'WARNING',
  SKIPPED: 'SKIPPED',
});

export const ReleaseDecision = Object.freeze({
  PROCEED: 'PROCEED',
  BLOCKED: 'BLOCKED',
  REQUIRES_APPROVAL: 'REQUIRES_APPROVAL',
});

export const REQUIRED_COLLECTIONS = Object.freeze([
  'users',
  'materials',
  'purchases',
  'entitlement_cache',
  'refunds',
  'audit_ledger',
]);

export const REQUIRED_ENV_VARS = Object.freeze([
  'JWT_SECRET',
  'NEXT_PUBLIC_STELLAR_NETWORK',
]);

/**
 * Validates deployment actor authorization.
 *
 * @param {object} actor - { id, role, permissions }
 * @returns {{ status: string, message: string, details?: object }}
 */
export function checkDeploymentAuthorization(actor) {
  if (!actor || typeof actor !== 'object') {
    return {
      status: CheckStatus.FAILED,
      message: 'Deployment actor missing. Releases must be executed by an authorized operator.',
    };
  }

  const role = (actor.role || '').toLowerCase();
  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];

  const isAuthorized =
    role === 'admin' ||
    role === 'deployer' ||
    role === 'release_engineer' ||
    permissions.includes('system:migrate') ||
    permissions.includes('system:release');

  if (!isAuthorized) {
    return {
      status: CheckStatus.FAILED,
      message: `Actor "${actor.id || 'anonymous'}" with role "${actor.role || 'none'}" is not authorized for release.`,
      details: { requiredRoles: ['admin', 'deployer', 'release_engineer'] },
    };
  }

  return {
    status: CheckStatus.PASSED,
    message: `Actor "${actor.id || 'operator'}" authorized under role "${role}".`,
  };
}

/**
 * Checks environment configuration readiness.
 *
 * @param {object} env
 * @returns {{ status: string, message: string, details?: object }}
 */
export function checkEnvironmentReadiness(env = process.env) {
  const missing = [];
  for (const key of REQUIRED_ENV_VARS) {
    if (!env[key] || String(env[key]).trim().length === 0) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    return {
      status: CheckStatus.FAILED,
      message: `Missing required environment variables: ${missing.join(', ')}`,
      details: { missing },
    };
  }

  const network = env.NEXT_PUBLIC_STELLAR_NETWORK;
  if (!['PUBLIC', 'TESTNET', 'FUTURENET', 'LOCAL'].includes(network)) {
    return {
      status: CheckStatus.WARNING,
      message: `Unrecognized NEXT_PUBLIC_STELLAR_NETWORK="${network}". Defaulting to TESTNET semantics.`,
    };
  }

  return {
    status: CheckStatus.PASSED,
    message: `Environment configuration verified for network "${network}".`,
  };
}

/**
 * Inspects migration readiness against collection schemas and registered migrations.
 *
 * @param {object} opts
 * @param {object} opts.db - MongoDB instance or mock
 * @param {Array<{ id: string, name: string, applied: boolean, reversible: boolean }>} [opts.registeredMigrations]
 * @returns {Promise<{ status: string, message: string, details?: object }>}
 */
export async function checkMigrationReadiness({ db = null, registeredMigrations = [] }) {
  if (!db) {
    return {
      status: CheckStatus.FAILED,
      message: 'Database connection unavailable for migration inspection.',
    };
  }

  try {
    const collections = await db.listCollections().toArray();
    const existingNames = new Set(collections.map(c => c.name));

    const missingCollections = REQUIRED_COLLECTIONS.filter(c => !existingNames.has(c));
    if (missingCollections.length > 0) {
      return {
        status: CheckStatus.WARNING,
        message: `Schema incomplete: missing collections [${missingCollections.join(', ')}]. Bootstrap or index setup needed.`,
        details: { missingCollections },
      };
    }

    const unapplied = registeredMigrations.filter(m => !m.applied);
    const nonReversible = unapplied.filter(m => !m.reversible);

    if (nonReversible.length > 0) {
      return {
        status: CheckStatus.FAILED,
        message: `Irreversible pending migrations detected: [${nonReversible.map(m => m.id).join(', ')}]. Down-migration required for release safety.`,
        details: { nonReversible: nonReversible.map(m => m.id) },
      };
    }

    if (unapplied.length > 0) {
      return {
        status: CheckStatus.WARNING,
        message: `${unapplied.length} pending migrations ready to apply.`,
        details: { pending: unapplied.map(m => m.id) },
      };
    }

    return {
      status: CheckStatus.PASSED,
      message: 'All database migrations applied and schema verified.',
      details: { activeCollections: existingNames.size },
    };
  } catch (err) {
    return {
      status: CheckStatus.FAILED,
      message: `Migration check failed: ${err.message}`,
    };
  }
}

/**
 * Executes a transient-tolerant smoke test with retry logic.
 *
 * @param {object} opts
 * @param {object} opts.db - MongoDB instance
 * @param {number} [opts.maxRetries=3]
 * @param {number} [opts.retryDelayMs=50]
 * @returns {Promise<{ status: string, message: string, retries: number, durationMs: number }>}
 */
export async function runReleaseSmokeTests({ db = null, maxRetries = 3, retryDelayMs = 50 }) {
  if (!db) {
    return {
      status: CheckStatus.FAILED,
      message: 'Smoke test failed: Database handle is required.',
      retries: 0,
      durationMs: 0,
    };
  }

  const startTime = Date.now();
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      const canaryId = `canary-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const canaryCol = db.collection('_release_canary');

      // Synthetic cycle: insert -> read -> delete
      await canaryCol.insertOne({ _id: canaryId, probeTime: new Date() });
      const read = await canaryCol.findOne({ _id: canaryId });
      if (!read) {
        throw new Error('Read-after-write consistency check failed on canary probe.');
      }
      await canaryCol.deleteOne({ _id: canaryId });

      return {
        status: CheckStatus.PASSED,
        message: 'Smoke test passed: Canary write/read/delete cycle successful.',
        retries: attempt - 1,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, retryDelayMs * attempt));
      }
    }
  }

  return {
    status: CheckStatus.FAILED,
    message: `Smoke test failed after ${maxRetries} attempts: ${lastError?.message}`,
    retries: attempt,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Verifies rollback readiness and backup freshness.
 *
 * @param {object} opts
 * @param {string} [opts.lastBackupTimestamp] - ISO timestamp of latest verified backup
 * @param {number} [opts.maxBackupAgeHours=24]
 * @param {boolean} [opts.hasRehearsedRollback=true]
 * @returns {{ status: string, message: string, details?: object }}
 */
export function checkRollbackReadiness({
  lastBackupTimestamp = null,
  maxBackupAgeHours = 24,
  hasRehearsedRollback = true,
} = {}) {
  if (!lastBackupTimestamp) {
    return {
      status: CheckStatus.FAILED,
      message: 'Rollback verification failed: No verified backup snapshot timestamp found.',
      details: { recommendation: 'Take an automated or manual Mongo snapshot before release.' },
    };
  }

  const backupAgeHours = (Date.now() - new Date(lastBackupTimestamp).getTime()) / (1000 * 60 * 60);

  if (isNaN(backupAgeHours) || backupAgeHours < 0) {
    return {
      status: CheckStatus.FAILED,
      message: 'Invalid backup snapshot timestamp format.',
    };
  }

  if (backupAgeHours > maxBackupAgeHours) {
    return {
      status: CheckStatus.WARNING,
      message: `Latest backup is ${backupAgeHours.toFixed(1)}h old (exceeds target ${maxBackupAgeHours}h).`,
      details: { backupAgeHours, maxBackupAgeHours },
    };
  }

  if (!hasRehearsedRollback) {
    return {
      status: CheckStatus.WARNING,
      message: 'Dry-run rollback rehearsal has not been performed for this release cycle.',
    };
  }

  return {
    status: CheckStatus.PASSED,
    message: `Rollback rehearsal verified. Valid snapshot exists (${backupAgeHours.toFixed(1)}h old).`,
    details: { backupAgeHours, hasRehearsedRollback },
  };
}

/**
 * Runs the complete Release Readiness check suite.
 *
 * @param {object} context
 * @param {object} context.actor
 * @param {object} context.db
 * @param {object} [context.env]
 * @param {Array}  [context.registeredMigrations]
 * @param {object} [context.rollbackOpts]
 * @param {boolean} [context.strictMode=false]
 * @returns {Promise<object>} Complete Release Readiness Report
 */
export async function evaluateReleaseReadiness({
  actor,
  db,
  env = process.env,
  registeredMigrations = [],
  rollbackOpts = {},
  strictMode = false,
}) {
  const timestamp = new Date().toISOString();
  const releaseId = `rel-${Date.now()}`;

  const authCheck = checkDeploymentAuthorization(actor);
  const envCheck = checkEnvironmentReadiness(env);
  const migrationCheck = await checkMigrationReadiness({ db, registeredMigrations });
  const smokeCheck = await runReleaseSmokeTests({ db });
  const rollbackCheck = checkRollbackReadiness(rollbackOpts);

  const checks = {
    authorization: authCheck,
    environment: envCheck,
    migrations: migrationCheck,
    smokeTests: smokeCheck,
    rollback: rollbackCheck,
  };

  let passed = 0;
  let failed = 0;
  let warnings = 0;

  for (const check of Object.values(checks)) {
    if (check.status === CheckStatus.PASSED) passed++;
    else if (check.status === CheckStatus.FAILED) failed++;
    else if (check.status === CheckStatus.WARNING) warnings++;
  }

  let decision = ReleaseDecision.PROCEED;
  if (failed > 0) {
    decision = ReleaseDecision.BLOCKED;
  } else if (warnings > 0) {
    decision = strictMode ? ReleaseDecision.BLOCKED : ReleaseDecision.REQUIRES_APPROVAL;
  }

  return {
    releaseId,
    timestamp,
    strictMode,
    actor: {
      id: actor?.id || 'unknown',
      role: actor?.role || 'none',
    },
    decision,
    summary: {
      total: Object.keys(checks).length,
      passed,
      failed,
      warnings,
    },
    checks,
  };
}
