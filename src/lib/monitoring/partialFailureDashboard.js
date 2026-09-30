/**
 * Partial Failure Dashboard for Background and External Integrations
 * Issue #812: Build partial failure dashboard for background and external integrations
 *
 * Provides visibility into operations stuck between internal state and external systems
 * so maintainers can resolve user-impacting failures quickly.
 *
 * Features:
 * - Track partially completed operations
 * - External reference IDs
 * - Group by type, age, severity, retryability
 * - Retry, inspect, and manual remediation links
 * - Metadata without secrets leakage
 */

import { getDb } from '../db/mongodb.js';
import logger from '../logger.js';

/**
 * Failure severity levels
 */
export const FailureSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/**
 * Operation types
 */
export const OperationType = {
  PAYMENT: 'payment',
  FILE_UPLOAD: 'file_upload',
  EMAIL: 'email',
  BLOCKCHAIN_TRANSACTION: 'blockchain_transaction',
  IPFS_PIN: 'ipfs_pin',
  INDEXER: 'indexer',
  WEBHOOK: 'webhook',
  EXTERNAL_API: 'external_api',
};

/**
 * Partial failure record
 * @typedef {object} PartialFailure
 * @property {string} operationType - Type of operation
 * @property {string} operationId - Internal operation ID
 * @property {string} [externalReferenceId] - External system reference
 * @property {string} userId - Associated user ID
 * @property {string} status - Current status
 * @property {string} severity - Failure severity
 * @property {boolean} retryable - Whether operation can be retried
 * @property {number} attemptCount - Number of retry attempts
 * @property {Date} firstFailedAt - First failure timestamp
 * @property {Date} lastAttemptAt - Last retry attempt
 * @property {string} errorMessage - Sanitized error message
 * @property {object} metadata - Additional context (secrets removed)
 * @property {string} [resolution] - Resolution status
 * @property {Date} [resolvedAt] - Resolution timestamp
 */

/**
 * Record a partial failure
 * @param {object} config - Failure configuration
 * @returns {Promise<PartialFailure>}
 */
export async function recordPartialFailure(config) {
  const db = await getDb();
  const failures = db.collection('partial_failures');

  // Check if failure already exists
  const existing = await failures.findOne({
    operationType: config.operationType,
    operationId: config.operationId,
    resolution: { $exists: false },
  });

  if (existing) {
    // Update existing failure
    await failures.updateOne(
      { _id: existing._id },
      {
        $set: {
          lastAttemptAt: new Date(),
          errorMessage: sanitizeErrorMessage(config.errorMessage),
          severity: calculateSeverity(existing, config),
        },
        $inc: { attemptCount: 1 },
        $push: {
          attemptHistory: {
            timestamp: new Date(),
            error: sanitizeErrorMessage(config.errorMessage),
          },
        },
      }
    );

    logger.warn('[Partial Failures] Updated existing failure', {
      failureId: existing._id,
      operationType: config.operationType,
      attemptCount: existing.attemptCount + 1,
    });

    return existing;
  }

  // Create new failure record
  const failure = {
    operationType: config.operationType,
    operationId: config.operationId,
    externalReferenceId: config.externalReferenceId || null,
    userId: config.userId,
    resourceId: config.resourceId || null,
    status: config.status || 'failed',
    severity: config.severity || FailureSeverity.MEDIUM,
    retryable: config.retryable !== false,
    attemptCount: 1,
    firstFailedAt: new Date(),
    lastAttemptAt: new Date(),
    errorMessage: sanitizeErrorMessage(config.errorMessage),
    errorCode: config.errorCode || null,
    metadata: sanitizeMetadata(config.metadata || {}),
    attemptHistory: [
      {
        timestamp: new Date(),
        error: sanitizeErrorMessage(config.errorMessage),
      },
    ],
    tags: config.tags || [],
  };

  const result = await failures.insertOne(failure);

  logger.error('[Partial Failures] New partial failure recorded', {
    failureId: result.insertedId,
    operationType: config.operationType,
    severity: failure.severity,
  });

  // Send alert for critical failures
  if (failure.severity === FailureSeverity.CRITICAL) {
    await sendCriticalFailureAlert(failure);
  }

  return { ...failure, _id: result.insertedId };
}

/**
 * Get dashboard view of partial failures
 * @param {object} [filters] - Filter options
 * @returns {Promise<object>} Dashboard data
 */
export async function getPartialFailuresDashboard(filters = {}) {
  const db = await getDb();
  const failures = db.collection('partial_failures');

  const query = buildDashboardQuery(filters);

  // Get failures
  const failureList = await failures
    .find(query)
    .sort({ firstFailedAt: -1 })
    .limit(filters.limit || 100)
    .toArray();

  // Get summary statistics
  const summary = await getDashboardSummary(failures, query);

  // Group by operation type
  const byType = await failures
    .aggregate([
      { $match: query },
      { $group: { _id: '$operationType', count: { $sum: 1 } } },
    ])
    .toArray();

  // Group by severity
  const bySeverity = await failures
    .aggregate([
      { $match: query },
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ])
    .toArray();

  // Age distribution
  const ageDistribution = calculateAgeDistribution(failureList);

  return {
    failures: failureList.map(enrichFailureForDashboard),
    summary,
    groupings: {
      byType: Object.fromEntries(byType.map((t) => [t._id, t.count])),
      bySeverity: Object.fromEntries(bySeverity.map((s) => [s._id, s.count])),
      byAge: ageDistribution,
    },
    filters: filters,
    timestamp: new Date(),
  };
}

/**
 * Retry a failed operation
 * @param {string} failureId - Failure ID
 * @param {object} [options] - Retry options
 * @returns {Promise<object>}
 */
export async function retryFailedOperation(failureId, options = {}) {
  const db = await getDb();
  const failures = db.collection('partial_failures');

  const failure = await failures.findOne({ _id: failureId });

  if (!failure) {
    throw new Error('Failure record not found');
  }

  if (!failure.retryable) {
    throw new Error('Operation is not retryable');
  }

  if (failure.resolution) {
    throw new Error('Failure already resolved');
  }

  // Dispatch retry based on operation type
  try {
    const result = await dispatchRetry(failure, options);

    // Mark as resolved if successful
    await failures.updateOne(
      { _id: failureId },
      {
        $set: {
          resolution: 'retry_succeeded',
          resolvedAt: new Date(),
          resolvedBy: options.userId || 'system',
          resolutionMetadata: result,
        },
      }
    );

    logger.info('[Partial Failures] Retry succeeded', {
      failureId,
      operationType: failure.operationType,
    });

    return { success: true, result };
  } catch (error) {
    // Update failure with new attempt
    await failures.updateOne(
      { _id: failureId },
      {
        $set: {
          lastAttemptAt: new Date(),
          errorMessage: sanitizeErrorMessage(error.message),
        },
        $inc: { attemptCount: 1 },
        $push: {
          attemptHistory: {
            timestamp: new Date(),
            error: sanitizeErrorMessage(error.message),
            retryTriggeredBy: options.userId || 'system',
          },
        },
      }
    );

    logger.error('[Partial Failures] Retry failed', {
      failureId,
      error: error.message,
    });

    throw error;
  }
}

/**
 * Mark failure as manually resolved
 * @param {string} failureId - Failure ID
 * @param {object} resolution - Resolution details
 * @returns {Promise<void>}
 */
export async function markAsManuallyResolved(failureId, resolution) {
  const db = await getDb();
  const failures = db.collection('partial_failures');

  const failure = await failures.findOne({ _id: failureId });

  if (!failure) {
    throw new Error('Failure record not found');
  }

  if (failure.resolution) {
    throw new Error('Failure already resolved');
  }

  await failures.updateOne(
    { _id: failureId },
    {
      $set: {
        resolution: 'manual_intervention',
        resolvedAt: new Date(),
        resolvedBy: resolution.userId,
        resolutionNotes: resolution.notes,
        resolutionMetadata: resolution.metadata || {},
      },
    }
  );

  logger.info('[Partial Failures] Marked as manually resolved', {
    failureId,
    resolvedBy: resolution.userId,
  });
}

/**
 * Mark failure as ignored
 * @param {string} failureId - Failure ID
 * @param {object} reason - Ignore reason
 * @returns {Promise<void>}
 */
export async function markAsIgnored(failureId, reason) {
  const db = await getDb();
  const failures = db.collection('partial_failures');

  await failures.updateOne(
    { _id: failureId },
    {
      $set: {
        resolution: 'ignored',
        resolvedAt: new Date(),
        resolvedBy: reason.userId,
        resolutionNotes: reason.notes,
      },
    }
  );

  logger.info('[Partial Failures] Marked as ignored', {
    failureId,
    reason: reason.notes,
  });
}

/**
 * Get failure details for inspection
 * @param {string} failureId - Failure ID
 * @returns {Promise<object>}
 */
export async function getFailureDetails(failureId) {
  const db = await getDb();
  const failures = db.collection('partial_failures');

  const failure = await failures.findOne({ _id: failureId });

  if (!failure) {
    throw new Error('Failure record not found');
  }

  // Get related records
  const relatedFailures = await failures
    .find({
      $or: [
        { userId: failure.userId },
        { operationId: failure.operationId },
        { externalReferenceId: failure.externalReferenceId },
      ],
      _id: { $ne: failureId },
    })
    .limit(10)
    .toArray();

  // Get remediation options
  const remediationOptions = getRemediationOptions(failure);

  return {
    failure: enrichFailureForDashboard(failure),
    relatedFailures: relatedFailures.map(enrichFailureForDashboard),
    remediationOptions,
    investigationLinks: generateInvestigationLinks(failure),
  };
}

/**
 * Helper functions
 */

function buildDashboardQuery(filters) {
  const query = { resolution: { $exists: false } };

  if (filters.operationType) {
    query.operationType = filters.operationType;
  }

  if (filters.severity) {
    query.severity = filters.severity;
  }

  if (filters.retryable !== undefined) {
    query.retryable = filters.retryable;
  }

  if (filters.userId) {
    query.userId = filters.userId;
  }

  if (filters.olderThan) {
    query.firstFailedAt = { $lt: new Date(Date.now() - filters.olderThan) };
  }

  if (filters.tags) {
    query.tags = { $in: filters.tags };
  }

  return query;
}

async function getDashboardSummary(collection, query) {
  const total = await collection.countDocuments(query);

  const criticalCount = await collection.countDocuments({
    ...query,
    severity: FailureSeverity.CRITICAL,
  });

  const retryableCount = await collection.countDocuments({
    ...query,
    retryable: true,
  });

  const staleCount = await collection.countDocuments({
    ...query,
    firstFailedAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });

  return {
    total,
    critical: criticalCount,
    retryable: retryableCount,
    stale: staleCount,
  };
}

function calculateAgeDistribution(failures) {
  const now = Date.now();
  const distribution = {
    lessThan1Hour: 0,
    '1to6Hours': 0,
    '6to24Hours': 0,
    '1to7Days': 0,
    moreThan7Days: 0,
  };

  for (const failure of failures) {
    const age = now - new Date(failure.firstFailedAt).getTime();
    const hours = age / (60 * 60 * 1000);

    if (hours < 1) distribution.lessThan1Hour++;
    else if (hours < 6) distribution['1to6Hours']++;
    else if (hours < 24) distribution['6to24Hours']++;
    else if (hours < 168) distribution['1to7Days']++;
    else distribution.moreThan7Days++;
  }

  return distribution;
}

function enrichFailureForDashboard(failure) {
  return {
    ...failure,
    age: Date.now() - new Date(failure.firstFailedAt).getTime(),
    ageFormatted: formatAge(failure.firstFailedAt),
    actionLinks: {
      retry: failure.retryable ? `/api/failures/${failure._id}/retry` : null,
      inspect: `/api/failures/${failure._id}`,
      resolve: `/api/failures/${failure._id}/resolve`,
      ignore: `/api/failures/${failure._id}/ignore`,
    },
  };
}

function formatAge(timestamp) {
  const age = Date.now() - new Date(timestamp).getTime();
  const hours = Math.floor(age / (60 * 60 * 1000));

  if (hours < 1) return 'Less than 1 hour';
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''}`;
}

function calculateSeverity(existing, config) {
  // Escalate severity based on attempt count
  if (existing.attemptCount >= 5) return FailureSeverity.HIGH;
  if (existing.attemptCount >= 3) return FailureSeverity.MEDIUM;
  return config.severity || existing.severity;
}

function sanitizeErrorMessage(message) {
  if (!message) return 'Unknown error';

  // Remove sensitive patterns
  let sanitized = String(message);

  // Remove API keys, tokens, passwords
  sanitized = sanitized.replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=***');
  sanitized = sanitized.replace(/token[=:]\s*\S+/gi, 'token=***');
  sanitized = sanitized.replace(/password[=:]\s*\S+/gi, 'password=***');
  sanitized = sanitized.replace(/secret[=:]\s*\S+/gi, 'secret=***');

  // Remove JWT tokens
  sanitized = sanitized.replace(
    /eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g,
    '***JWT***'
  );

  return sanitized;
}

function sanitizeMetadata(metadata) {
  const sanitized = { ...metadata };
  const sensitiveKeys = [
    'apiKey',
    'api_key',
    'token',
    'password',
    'secret',
    'privateKey',
    'private_key',
  ];

  for (const key of sensitiveKeys) {
    if (key in sanitized) {
      sanitized[key] = '***';
    }
  }

  return sanitized;
}

function getRemediationOptions(failure) {
  const options = [];

  if (failure.retryable) {
    options.push({
      action: 'retry',
      label: 'Retry Operation',
      description: 'Automatically retry the failed operation',
    });
  }

  options.push({
    action: 'manual_resolve',
    label: 'Mark as Resolved',
    description: 'Manually mark this failure as resolved after fixing',
  });

  options.push({
    action: 'ignore',
    label: 'Ignore',
    description: 'Ignore this failure (e.g., if it is expected)',
  });

  return options;
}

function generateInvestigationLinks(failure) {
  const links = [];

  if (failure.userId) {
    links.push({
      label: 'User Profile',
      url: `/admin/users/${failure.userId}`,
    });
  }

  if (failure.externalReferenceId) {
    links.push({
      label: 'External Reference',
      description: `ID: ${failure.externalReferenceId}`,
    });
  }

  if (failure.operationId) {
    links.push({
      label: 'Operation Logs',
      url: `/admin/logs?operation=${failure.operationId}`,
    });
  }

  return links;
}

async function dispatchRetry(failure, options) {
  // This would dispatch to the appropriate service based on operation type
  // For now, return a placeholder
  logger.info('[Partial Failures] Dispatching retry', {
    operationType: failure.operationType,
    operationId: failure.operationId,
  });

  return {
    retried: true,
    timestamp: new Date(),
  };
}

async function sendCriticalFailureAlert(failure) {
  logger.error('[Partial Failures] CRITICAL failure alert', {
    failureId: failure._id,
    operationType: failure.operationType,
    userId: failure.userId,
  });

  // Could integrate with alerting service (email, Slack, PagerDuty, etc.)
}

export default {
  recordPartialFailure,
  getPartialFailuresDashboard,
  retryFailedOperation,
  markAsManuallyResolved,
  markAsIgnored,
  getFailureDetails,
  FailureSeverity,
  OperationType,
};
