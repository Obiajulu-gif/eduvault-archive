/**
 * Partial-Failure Service & Aggregator (#957)
 *
 * Implements a unified management and observability layer for partial failures
 * across async background jobs, integration side-effects (outbox/indexer), and
 * user-visible operations (purchases/refunds/uploads).
 *
 * Provides:
 * - Domain-aware aggregation & filtering
 * - User-action detection & guidance
 * - Safe, idempotent retries with audit logging
 * - Sensitive payload redaction
 */

import { redactSensitiveDetails } from './operationalHealth.js';
import { appendAuditRecord } from './auditLedger.js';
import { COLLECTIONS } from './schemaContracts.js';

export const PARTIAL_FAILURE_DOMAINS = {
  ASYNC_JOBS: 'async_jobs',
  INTEGRATIONS: 'integrations',
  USER_OPERATIONS: 'user_operations',
};

export const PARTIAL_FAILURE_STATUSES = {
  UNRESOLVED: 'unresolved',
  RETRYING: 'retrying',
  RESOLVED: 'resolved',
  ABANDONED: 'abandoned',
};

export const SEVERITIES = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

/**
 * Evaluates whether an error condition requires explicit user action.
 *
 * @param {string|object} error
 * @returns {{ required: boolean, reasonCode: string|null, type: string|null, guidance: string|null, message: string|null }}
 */
export function detectUserActionRequirement(error = '') {
  const text = typeof error === 'object' && error !== null
    ? `${error.code || ''} ${error.message || error.lastError || JSON.stringify(error)}`.toLowerCase()
    : String(error || '').toLowerCase();

  if (text.includes('wallet_insufficient_funds') || text.includes('insufficient funds') || text.includes('balance') || text.includes('trustline')) {
    const guidance = 'User action required: Insufficient wallet balance or missing trustline to settle transaction. Ask user to fund wallet.';
    return {
      required: true,
      reasonCode: 'WALLET_INSUFFICIENT_FUNDS',
      type: 'fund_wallet_or_trustline',
      guidance,
      message: guidance,
    };
  }

  if (text.includes('storage_quota') || text.includes('quota exceeded') || text.includes('storage limit')) {
    const guidance = 'User action required: Storage quota exceeded. User must upgrade plan or purge obsolete files.';
    return {
      required: true,
      reasonCode: 'STORAGE_QUOTA_EXCEEDED',
      type: 'upgrade_storage_quota',
      guidance,
      message: guidance,
    };
  }

  if (text.includes('account_suspended') || text.includes('user_suspended') || text.includes('creator suspended')) {
    const guidance = 'User action required: Account has been suspended. Creator must contact support or appeal suspension.';
    return {
      required: true,
      reasonCode: 'ACCOUNT_SUSPENDED',
      type: 'account_appeal',
      guidance,
      message: guidance,
    };
  }

  if (text.includes('signature_expired') || text.includes('signature invalid')) {
    const guidance = 'User action required: Cryptographic signature expired or invalid. User must resign request.';
    return {
      required: true,
      reasonCode: 'SIGNATURE_EXPIRED',
      type: 'resign_payload',
      guidance,
      message: guidance,
    };
  }

  return { required: false, reasonCode: null, type: null, guidance: null, message: null };
}

/**
 * Normalizes a heterogeneous failure document into a standardized partial-failure schema.
 */
function normalizeFailure({
  failureId,
  domain,
  sourceCollection,
  sourceId,
  operation,
  status = PARTIAL_FAILURE_STATUSES.UNRESOLVED,
  severity = SEVERITIES.MEDIUM,
  requiresUserAction = false,
  userActionType = null,
  userActionGuidance = null,
  errorCause = {},
  context = {},
  canRetrySafely = true,
  createdAt = new Date(),
  updatedAt = new Date(),
}) {
  return {
    failureId: String(failureId),
    domain,
    sourceCollection,
    sourceId: String(sourceId),
    operation,
    status,
    severity,
    requiresUserAction: Boolean(requiresUserAction),
    userActionType,
    userActionGuidance,
    errorCause: {
      message: errorCause.message || 'Unknown error',
      code: errorCause.code || 'UNKNOWN_ERROR',
      retryCount: Number(errorCause.retryCount || 0),
      maxRetries: Number(errorCause.maxRetries || 3),
      lastAttemptAt: errorCause.lastAttemptAt || updatedAt,
    },
    context: redactSensitiveDetails(context),
    canRetrySafely: Boolean(canRetrySafely),
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
  };
}

/**
 * Query and aggregate partial failures across background jobs, integrations, and user operations.
 *
 * @param {import('mongodb').Db} db - Connected MongoDB instance
 * @param {object} [filter]
 * @param {string} [filter.domain] - Filter by domain ('async_jobs', 'integrations', 'user_operations', or 'all')
 * @param {string} [filter.status] - Filter by status ('unresolved', 'resolved', 'retrying', 'abandoned')
 * @param {string} [filter.severity] - Filter by severity ('critical', 'high', 'medium', 'low')
 * @param {boolean} [filter.requiresUserAction] - Filter by whether user action is required
 * @param {number} [filter.limit=50]
 * @param {number} [filter.offset=0]
 * @returns {Promise<{ items: Array, summary: object }>}
 */
export async function getPartialFailures(db, filter = {}) {
  const targetDomain = filter.domain && filter.domain !== 'all' ? filter.domain : null;
  const targetStatus = filter.status === 'all'
    ? null
    : (filter.status || PARTIAL_FAILURE_STATUSES.UNRESOLVED);
  const targetSeverity = filter.severity && filter.severity !== 'all' ? filter.severity : null;
  const limit = Math.min(Math.max(1, Number(filter.limit) || 50), 200);
  const offset = Math.max(0, Number(filter.offset) || 0);

  const rawFailures = [];

  // 1. Domain: Async Background Jobs
  if (!targetDomain || targetDomain === PARTIAL_FAILURE_DOMAINS.ASYNC_JOBS) {
    try {
      const jobsCol = db.collection('background_jobs');
      const query = { status: { $in: ['dead_letter', 'failed'] } };
      const failedJobs = await jobsCol.find(query).sort({ updatedAt: -1 }).limit(100).toArray();

      for (const job of failedJobs) {
        const attempts = job.attempts || job.retryCount || 0;
        const maxAttempts = job.maxAttempts || 3;
        const isPermanent = attempts >= maxAttempts || job.status === 'dead_letter';
        const errorMsg = job.error?.message || job.lastError || (typeof job.error === 'string' ? job.error : 'Job execution failed');
        const userAction = detectUserActionRequirement(errorMsg);

        rawFailures.push(normalizeFailure({
          failureId: `job_${job._id || job.jobId}`,
          domain: PARTIAL_FAILURE_DOMAINS.ASYNC_JOBS,
          sourceCollection: 'background_jobs',
          sourceId: job._id || job.jobId,
          operation: job.name || job.type || 'background_job',
          status: job.resolutionStatus || PARTIAL_FAILURE_STATUSES.UNRESOLVED,
          severity: isPermanent ? SEVERITIES.HIGH : SEVERITIES.MEDIUM,
          requiresUserAction: userAction.required,
          userActionType: userAction.type,
          userActionGuidance: userAction.guidance,
          errorCause: {
            message: errorMsg,
            code: job.error?.code || (userAction.required ? userAction.reasonCode : 'JOB_EXECUTION_FAILED'),
            retryCount: attempts,
            maxRetries: maxAttempts,
            lastAttemptAt: job.updatedAt || job.failedAt || job.createdAt,
          },
          context: job.payload || {},
          canRetrySafely: !userAction.required && !isPermanent,
          createdAt: job.createdAt || new Date(),
          updatedAt: job.updatedAt || new Date(),
        }));
      }
    } catch {}
  }

  // 2. Domain: Integrations (Outbox, Indexer Deadletters, Pinata/IPFS)
  if (!targetDomain || targetDomain === PARTIAL_FAILURE_DOMAINS.INTEGRATIONS) {
    // 2a. Side-effect Outbox Failures
    try {
      const outboxCol = db.collection('side_effect_outbox');
      const query = { status: { $in: ['failed', 'dead_letter'] } };
      const failedOutbox = await outboxCol.find(query).sort({ updatedAt: -1 }).limit(100).toArray();

      for (const item of failedOutbox) {
        const errorMsg = item.lastError || item.error || 'Outbox integration delivery failed';
        const userAction = detectUserActionRequirement(errorMsg);

        rawFailures.push(normalizeFailure({
          failureId: `outbox_${item._id || item.eventId}`,
          domain: PARTIAL_FAILURE_DOMAINS.INTEGRATIONS,
          sourceCollection: 'side_effect_outbox',
          sourceId: item._id || item.eventId,
          operation: `outbox:${item.eventType || item.type || 'integration_event'}`,
          status: item.resolutionStatus || PARTIAL_FAILURE_STATUSES.UNRESOLVED,
          severity: SEVERITIES.HIGH,
          requiresUserAction: userAction.required,
          userActionType: userAction.type,
          userActionGuidance: userAction.guidance,
          errorCause: {
            message: errorMsg,
            code: userAction.required ? userAction.reasonCode : 'OUTBOX_DELIVERY_FAILURE',
            retryCount: item.attempts || item.retryCount || 0,
            maxRetries: item.maxAttempts || 5,
            lastAttemptAt: item.updatedAt || item.createdAt,
          },
          context: item.payload || {},
          canRetrySafely: !userAction.required,
          createdAt: item.createdAt || new Date(),
          updatedAt: item.updatedAt || new Date(),
        }));
      }
    } catch {}

    // 2b. Indexer Deadletters
    try {
      const indexerCol = db.collection('indexer_deadletters');
      const deadletters = await indexerCol.find({
        $or: [
          { status: { $in: ['pending', 'unresolved', 'failed'] } },
          { resolved: false },
        ],
      }).sort({ createdAt: -1 }).limit(100).toArray();

      for (const item of deadletters) {
        const errorMsg = item.error || item.message || 'Indexer ledger sync failed';
        const userAction = detectUserActionRequirement(errorMsg);

        rawFailures.push(normalizeFailure({
          failureId: `indexer_${item._id || item.deadLetterId}`,
          domain: PARTIAL_FAILURE_DOMAINS.INTEGRATIONS,
          sourceCollection: 'indexer_deadletters',
          sourceId: item._id || item.deadLetterId,
          operation: `indexer:${item.operation || item.reason || 'blockchain_event'}`,
          status: item.resolutionStatus || (item.resolved ? PARTIAL_FAILURE_STATUSES.RESOLVED : PARTIAL_FAILURE_STATUSES.UNRESOLVED),
          severity: SEVERITIES.CRITICAL,
          requiresUserAction: userAction.required,
          userActionType: userAction.type,
          userActionGuidance: userAction.guidance,
          errorCause: {
            message: errorMsg,
            code: userAction.required ? userAction.reasonCode : 'INDEXER_SYNC_ERROR',
            retryCount: item.retryCount || 0,
            maxRetries: 3,
            lastAttemptAt: item.updatedAt || item.createdAt,
          },
          context: { ledger: item.ledger, event: item.event, txHash: item.txHash, cursor: item.cursor },
          canRetrySafely: !userAction.required,
          createdAt: item.createdAt || new Date(),
          updatedAt: item.updatedAt || new Date(),
        }));
      }
    } catch {}
  }

  // 3. Domain: User-Visible Operations (Refunds, Purchases, Quarantined Content)
  if (!targetDomain || targetDomain === PARTIAL_FAILURE_DOMAINS.USER_OPERATIONS) {
    // 3a. Failed Refunds
    try {
      const refundsCol = db.collection(COLLECTIONS.refunds || 'refunds');
      const failedRefunds = await refundsCol.find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(100).toArray();

      for (const refund of failedRefunds) {
        const errorMsg = refund.failureReason || refund.error || 'Refund execution halted on-chain';
        const userAction = detectUserActionRequirement(errorMsg);
        const requiresUser = userAction.required || errorMsg.includes('wallet') || errorMsg.includes('kyc');

        rawFailures.push(normalizeFailure({
          failureId: `refund_${refund._id || refund.refundId}`,
          domain: PARTIAL_FAILURE_DOMAINS.USER_OPERATIONS,
          sourceCollection: 'refunds',
          sourceId: refund._id || refund.refundId,
          operation: 'payout:refund_execution',
          status: refund.resolutionStatus || PARTIAL_FAILURE_STATUSES.UNRESOLVED,
          severity: SEVERITIES.HIGH,
          requiresUserAction: requiresUser,
          userActionType: requiresUser ? (userAction.type || 'reconnect_wallet') : null,
          userActionGuidance: requiresUser
            ? (userAction.guidance || 'User destination account is invalid or unable to receive tokens. Please ask user to verify receiving trustline.')
            : null,
          errorCause: {
            message: errorMsg,
            code: userAction.reasonCode || 'REFUND_SETTLEMENT_FAILED',
            retryCount: refund.retryCount || 0,
            maxRetries: 3,
            lastAttemptAt: refund.updatedAt || refund.createdAt,
          },
          context: {
            purchaseId: refund.purchaseId,
            buyerAddress: refund.buyerAddress,
            amount: refund.amount,
            currency: refund.currency,
          },
          canRetrySafely: !requiresUser,
          createdAt: refund.createdAt || new Date(),
          updatedAt: refund.updatedAt || new Date(),
        }));
      }
    } catch {}

    // 3b. Quarantined Content (uploads with security or scanning exceptions)
    try {
      const materialsCol = db.collection('materials');
      const quarantined = await materialsCol.find({
        $or: [
          { quarantineState: { $in: ['infected', 'scan_error', 'unverified'] } },
          { quarantineReason: { $exists: true, $ne: null } },
        ],
      }).sort({ updatedAt: -1 }).limit(100).toArray();

      for (const item of quarantined) {
        const errorMsg = item.quarantineReason || 'Content failed integrity/safety check';
        const userAction = detectUserActionRequirement(errorMsg);

        rawFailures.push(normalizeFailure({
          failureId: `quarantine_${item._id || item.materialId}`,
          domain: PARTIAL_FAILURE_DOMAINS.USER_OPERATIONS,
          sourceCollection: 'materials',
          sourceId: item._id || item.materialId,
          operation: 'storage:content_quarantine',
          status: item.resolutionStatus || PARTIAL_FAILURE_STATUSES.UNRESOLVED,
          severity: item.quarantineState === 'infected' ? SEVERITIES.CRITICAL : SEVERITIES.MEDIUM,
          requiresUserAction: true,
          userActionType: userAction.type || 'reupload_clean_file',
          userActionGuidance: userAction.guidance || 'Uploaded file flagged by scanner. Creator must upload a clean, uncorrupted version.',
          errorCause: {
            message: errorMsg,
            code: userAction.reasonCode || 'CONTENT_QUARANTINED',
            retryCount: 0,
            maxRetries: 0,
            lastAttemptAt: item.updatedAt || item.createdAt,
          },
          context: {
            title: item.title,
            creatorAddress: item.userAddress,
            storageKey: item.storageKey,
            importBatchId: item.importBatchId,
          },
          canRetrySafely: false,
          createdAt: item.createdAt || new Date(),
          updatedAt: item.updatedAt || new Date(),
        }));
      }
    } catch {}
  }

  // Filter in-memory by status, severity, and user-action requirements
  let filtered = rawFailures.filter((item) => {
    if (targetStatus && item.status !== targetStatus) return false;
    if (targetSeverity && item.severity !== targetSeverity) return false;
    if (filter.requiresUserAction !== undefined) {
      const needAction = String(filter.requiresUserAction) === 'true';
      if (item.requiresUserAction !== needAction) return false;
    }
    return true;
  });

  // Calculate high-level operator summary metrics
  const total = filtered.length;
  const requiresUserActionCount = filtered.filter((i) => i.requiresUserAction).length;
  const byDomain = {
    [PARTIAL_FAILURE_DOMAINS.ASYNC_JOBS]: filtered.filter((i) => i.domain === PARTIAL_FAILURE_DOMAINS.ASYNC_JOBS).length,
    [PARTIAL_FAILURE_DOMAINS.INTEGRATIONS]: filtered.filter((i) => i.domain === PARTIAL_FAILURE_DOMAINS.INTEGRATIONS).length,
    [PARTIAL_FAILURE_DOMAINS.USER_OPERATIONS]: filtered.filter((i) => i.domain === PARTIAL_FAILURE_DOMAINS.USER_OPERATIONS).length,
  };
  const bySeverity = {
    [SEVERITIES.CRITICAL]: filtered.filter((i) => i.severity === SEVERITIES.CRITICAL).length,
    [SEVERITIES.HIGH]: filtered.filter((i) => i.severity === SEVERITIES.HIGH).length,
    [SEVERITIES.MEDIUM]: filtered.filter((i) => i.severity === SEVERITIES.MEDIUM).length,
    [SEVERITIES.LOW]: filtered.filter((i) => i.severity === SEVERITIES.LOW).length,
  };

  const paginatedItems = filtered.slice(offset, offset + limit);

  return {
    items: paginatedItems,
    summary: {
      total,
      unresolved: filtered.filter((i) => i.status === PARTIAL_FAILURE_STATUSES.UNRESOLVED).length,
      requiresUserActionCount,
      byDomain,
      bySeverity,
      limit,
      offset,
    },
  };
}

/**
 * Safely retry an unresolved partial failure.
 *
 * @param {import('mongodb').Db} db
 * @param {string} failureId
 * @param {object} options
 * @param {string} options.actor - Operator address or ID
 * @param {string} [options.reason]
 * @returns {Promise<{ ok: boolean, message: string, retriedAt: Date }>}
 */
export async function retryPartialFailure(db, failureId, { actor = 'system', reason = 'Operator triggered retry' } = {}) {
  const { items } = await getPartialFailures(db, { status: 'all', limit: 500 });
  const failure = items.find((f) => f.failureId === failureId);

  if (!failure) {
    throw new Error(`Partial failure not found: ${failureId}`);
  }

  if (!failure.canRetrySafely) {
    throw new Error(`Failure ${failureId} cannot be safely auto-retried. User or manual intervention is required.`);
  }

  const now = new Date();

  // Route safe retry according to the source collection
  if (failure.sourceCollection === 'background_jobs') {
    const col = db.collection('background_jobs');
    const updateResult = await col.updateOne(
      { _id: failure.sourceId },
      {
        $set: {
          status: 'pending',
          scheduledFor: now,
          resolutionStatus: PARTIAL_FAILURE_STATUSES.RETRYING,
          lastOperatorAction: { actor, action: 'retry', timestamp: now, reason },
        },
      }
    );
    if (updateResult.matchedCount === 0) {
      await col.updateOne({ jobId: failure.sourceId }, {
        $set: { status: 'pending', scheduledFor: now, resolutionStatus: PARTIAL_FAILURE_STATUSES.RETRYING },
      });
    }
  } else if (failure.sourceCollection === 'side_effect_outbox') {
    await db.collection('side_effect_outbox').updateOne(
      { _id: failure.sourceId },
      {
        $set: {
          status: 'pending',
          leaseExpiresAt: null,
          nextAttemptAt: now,
          resolutionStatus: PARTIAL_FAILURE_STATUSES.RETRYING,
          updatedAt: now,
        },
      }
    );
  } else if (failure.sourceCollection === 'indexer_deadletters') {
    await db.collection('indexer_deadletters').updateOne(
      { _id: failure.sourceId },
      {
        $set: {
          status: 'pending',
          resolutionStatus: PARTIAL_FAILURE_STATUSES.RETRYING,
          retryRequestedAt: now,
        },
      }
    );
  } else if (failure.sourceCollection === 'refunds') {
    await db.collection('refunds').updateOne(
      { _id: failure.sourceId },
      {
        $set: {
          status: 'pending',
          resolutionStatus: PARTIAL_FAILURE_STATUSES.RETRYING,
          retryRequestedAt: now,
        },
      }
    );
  }

  // Audit trail the operator intervention
  try {
    await appendAuditRecord({
      db,
      operationId: `retry_${failureId}_${Date.now()}`,
      actor,
      action: 'operator_retry_partial_failure',
      target: { type: failure.sourceCollection, id: failure.sourceId },
      reason,
      result: { status: 'retry_queued', failureId },
    });
  } catch {}

  return {
    ok: true,
    message: `Retry successfully queued for ${failure.operation} (${failureId})`,
    retriedAt: now,
  };
}

/**
 * Mark a partial failure as resolved or abandoned with operator notes.
 */
export async function resolvePartialFailure(db, failureId, { actor = 'system', resolution = 'resolved', note = '' } = {}) {
  const { items } = await getPartialFailures(db, { status: 'all', limit: 500 });
  const failure = items.find((f) => f.failureId === failureId);

  if (!failure) {
    throw new Error(`Partial failure not found: ${failureId}`);
  }

  const now = new Date();
  const targetStatus = resolution === 'abandoned'
    ? PARTIAL_FAILURE_STATUSES.ABANDONED
    : PARTIAL_FAILURE_STATUSES.RESOLVED;

  // Persist resolution state in target collection
  const col = db.collection(failure.sourceCollection);
  const updateResult = await col.updateOne(
    { _id: failure.sourceId },
    {
      $set: {
        resolutionStatus: targetStatus,
        resolvedAt: now,
        resolvedBy: actor,
        resolutionNote: note,
      },
    }
  );
  if (updateResult && updateResult.matchedCount === 0) {
    await col.updateOne(
      { jobId: failure.sourceId },
      {
        $set: {
          resolutionStatus: targetStatus,
          resolvedAt: now,
          resolvedBy: actor,
          resolutionNote: note,
        },
      }
    );
  }

  // Log in append-only audit ledger
  try {
    await appendAuditRecord({
      db,
      operationId: `resolve_${failureId}_${Date.now()}`,
      actor,
      action: 'operator_resolve_partial_failure',
      target: { type: failure.sourceCollection, id: failure.sourceId },
      reason: note || `Marked ${targetStatus}`,
      result: { status: targetStatus, failureId },
    });
  } catch {}

  return {
    ok: true,
    status: targetStatus,
    resolvedAt: now,
  };
}
