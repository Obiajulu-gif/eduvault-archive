/**
 * Operational Health Aggregator & Unresolved Exceptions Service
 *
 * Implements Issue #798:
 * Aggregates operational health indicators, unresolved failures, stale jobs,
 * reconciliation drift, and user-impacting incidents across EduVault collections.
 * Automatically redacts sensitive data from maintainer summaries.
 */

/**
 * Redact sensitive fields (keys, secrets, emails, auth headers) from records.
 * Ensures maintainer reports and dashboards are audit-safe.
 */
export function redactSensitiveDetails(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveDetails(item));
  }

  const redacted = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    // Check specific value patterns first
    if (typeof value === 'string' && /^S[A-Z0-9]{55}$/.test(value)) {
      // Stellar secret key pattern (starts with S, 56 chars)
      redacted[key] = '[REDACTED_STELLAR_SECRET_KEY]';
    } else if (typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)) {
      // 32-byte EVM private key pattern
      redacted[key] = '[REDACTED_EVM_PRIVATE_KEY]';
    } else if (
      lowerKey.includes('secret') ||
      lowerKey.includes('privatekey') ||
      lowerKey.includes('token') ||
      lowerKey.includes('password') ||
      lowerKey.includes('authorization') ||
      lowerKey.includes('apikey')
    ) {
      redacted[key] = '[REDACTED]';
    } else if (lowerKey.includes('email') && typeof value === 'string' && value.includes('@')) {
      const [local, domain] = value.split('@');
      const maskedLocal = local.length > 2 ? `${local[0]}***${local[local.length - 1]}` : '***';
      redacted[key] = `${maskedLocal}@${domain}`;
    } else if (value && typeof value === 'object' && !(value instanceof Date)) {
      redacted[key] = redactSensitiveDetails(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Query and aggregate operational health metrics from database collections.
 *
 * @param {import('mongodb').Db} db - Connected MongoDB instance
 * @param {object} [options]
 * @param {number} [options.staleThresholdMs=3600000] - 1 hour threshold for stale intents
 * @param {number} [options.recentWindowMs=86400000] - 24 hours window for incident trends
 * @returns {Promise<object>} Operational health report
 */
export async function getOperationalHealth(db, options = {}) {
  const staleThresholdMs = options.staleThresholdMs ?? 3_600_000; // 1 hour
  const recentWindowMs = options.recentWindowMs ?? 86_400_000; // 24 hours
  const now = new Date();
  const staleTime = new Date(now.getTime() - staleThresholdMs);
  const recentTime = new Date(now.getTime() - recentWindowMs);

  // 1. Unresolved Failures & Exceptions
  let failedOutboxCount = 0;
  let unresolvedDeadlettersCount = 0;
  let failedRefundsCount = 0;
  let quarantinedFilesCount = 0;
  let unresolvedItemsSample = [];

  try {
    const outboxCollection = db.collection('outbox');
    failedOutboxCount = await outboxCollection.countDocuments({ status: 'failed' });

    const failedOutboxDocs = await outboxCollection
      .find({ status: 'failed' })
      .sort({ updatedAt: -1 })
      .limit(5)
      .toArray();

    failedOutboxDocs.forEach((doc) => {
      unresolvedItemsSample.push({
        id: String(doc._id),
        category: 'outbox_failure',
        description: `Failed event: ${doc.eventType || doc.type || 'unknown'}`,
        lastError: doc.lastError || doc.error || 'Unknown error',
        updatedAt: doc.updatedAt || doc.createdAt,
        investigationUrl: `/admin/outbox/${doc._id}`,
      });
    });
  } catch {
    // collection may not exist yet in test environments
  }

  try {
    const deadlettersCollection = db.collection('indexer_deadletters');
    unresolvedDeadlettersCount = await deadlettersCollection.countDocuments({
      status: { $in: ['pending', 'unresolved'] },
    });

    const deadletterDocs = await deadlettersCollection
      .find({ status: { $in: ['pending', 'unresolved'] } })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();

    deadletterDocs.forEach((doc) => {
      unresolvedItemsSample.push({
        id: String(doc._id),
        category: 'deadletter',
        description: `Deadletter: ${doc.reason || doc.operation || 'indexer_failure'}`,
        lastError: doc.error || doc.message || 'Processing failed',
        updatedAt: doc.createdAt,
        investigationUrl: `/admin/indexer/deadletters/${doc._id}`,
      });
    });
  } catch {}

  try {
    const refundsCollection = db.collection('refunds');
    failedRefundsCount = await refundsCollection.countDocuments({ status: 'failed' });
  } catch {}

  try {
    const materialsCollection = db.collection('materials');
    quarantinedFilesCount = await materialsCollection.countDocuments({
      quarantineState: 'infected',
    });
  } catch {}

  // 2. Stale Jobs
  let staleIntentsCount = 0;
  let staleStorageJobsCount = 0;
  let staleJobsSample = [];

  try {
    const intentsCollection = db.collection('checkout_intents');
    staleIntentsCount = await intentsCollection.countDocuments({
      status: 'pending',
      createdAt: { $lt: staleTime },
    });

    const staleIntentDocs = await intentsCollection
      .find({ status: 'pending', createdAt: { $lt: staleTime } })
      .limit(5)
      .toArray();

    staleIntentDocs.forEach((doc) => {
      staleJobsSample.push({
        id: String(doc._id),
        type: 'checkout_intent',
        createdAt: doc.createdAt,
        ageMinutes: Math.round((now.getTime() - new Date(doc.createdAt).getTime()) / 60000),
      });
    });
  } catch {}

  try {
    const storageJobsCollection = db.collection('storage_jobs');
    staleStorageJobsCount = await storageJobsCollection.countDocuments({
      status: 'running',
      startedAt: { $lt: staleTime },
    });
  } catch {}

  // 3. Reconciliation Drift
  let purchaseDriftCount = 0;
  let unverifiedPinsCount = 0;

  try {
    const purchasesCollection = db.collection('purchases');
    purchaseDriftCount = await purchasesCollection.countDocuments({
      $or: [
        { reconciliationStatus: { $in: ['drift', 'mismatch', 'unreconciled'] } },
        { onChainVerified: false, status: 'completed' },
      ],
    });
  } catch {}

  try {
    const materialsCollection = db.collection('materials');
    unverifiedPinsCount = await materialsCollection.countDocuments({
      pinVerified: false,
      isDeleted: { $ne: true },
    });
  } catch {}

  // 4. User-Impacting Incidents & Operational Health Indicators
  let accessDeniedCount = 0;
  let suspendedUsersCount = 0;

  try {
    const accessLogCollection = db.collection('download_access_logs');
    accessDeniedCount = await accessLogCollection.countDocuments({
      event: 'access_denied',
      timestamp: { $gte: recentTime },
    });
  } catch {}

  try {
    const usersCollection = db.collection('users');
    suspendedUsersCount = await usersCollection.countDocuments({ isSuspended: true });
  } catch {}

  // Calculate Overall System Status
  let overallStatus = 'healthy';
  const alerts = [];

  if (failedOutboxCount > 0 || unresolvedDeadlettersCount > 0 || failedRefundsCount > 0) {
    overallStatus = 'critical';
    alerts.push('Unresolved backend exceptions or deadletter jobs require attention.');
  }

  if (purchaseDriftCount > 0 || staleIntentsCount > 10) {
    if (overallStatus !== 'critical') overallStatus = 'warning';
    alerts.push('Reconciliation drift or stale jobs detected.');
  }

  if (quarantinedFilesCount > 0) {
    if (overallStatus !== 'critical') overallStatus = 'warning';
    alerts.push('Files in quarantine state detected.');
  }

  const report = {
    status: overallStatus,
    timestamp: now.toISOString(),
    indicators: {
      unresolvedFailures: {
        total: failedOutboxCount + unresolvedDeadlettersCount + failedRefundsCount + quarantinedFilesCount,
        failedOutbox: failedOutboxCount,
        unresolvedDeadletters: unresolvedDeadlettersCount,
        failedRefunds: failedRefundsCount,
        quarantinedFiles: quarantinedFilesCount,
      },
      staleJobs: {
        total: staleIntentsCount + staleStorageJobsCount,
        staleIntents: staleIntentsCount,
        staleStorageJobs: staleStorageJobsCount,
      },
      reconciliationDrift: {
        total: purchaseDriftCount + unverifiedPinsCount,
        purchaseDrift: purchaseDriftCount,
        unverifiedPins: unverifiedPinsCount,
      },
      userImpactingIncidents: {
        recentAccessDenials: accessDeniedCount,
        suspendedUsers: suspendedUsersCount,
      },
    },
    actionableItems: {
      unresolvedExceptions: unresolvedItemsSample.map(redactSensitiveDetails),
      staleJobsSample: staleJobsSample.map(redactSensitiveDetails),
    },
    alerts,
  };

  return report;
}
