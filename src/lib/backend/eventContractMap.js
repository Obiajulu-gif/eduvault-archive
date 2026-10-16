/**
 * Cross-Service Domain Event Contract Map & Boundary Registry (#960)
 *
 * Provides a centralized, machine-readable contract registry and runtime validator
 * for all asynchronous domain events, integration boundaries, and messaging flows
 * across EduVault services (Marketplace, Payouts, Content Safety, Indexer, IAM).
 *
 * Each contract defines:
 * - Domain and Event Type
 * - Service Producers & Entrypoints
 * - Service Consumers & Handlers
 * - Required Fields & Schema Typing
 * - Schema Versioning & Evolution Rules
 * - Allowed Failure Behaviors & Dead-Letter / Retry Strategies
 */

export const CONTRACT_MAP_VERSION = '1.0.0';

export const DOMAINS = {
  MARKETPLACE: 'marketplace',
  FINANCE: 'finance',
  CONTENT: 'content',
  IDENTITY: 'identity',
  INDEXER: 'indexer',
  ARCHIVE: 'archive',
};

export const FAILURE_STRATEGIES = {
  RETRY_THEN_DEAD_LETTER: 'retry_then_dead_letter',
  FAIL_IMMEDIATE_CIRCUIT_BREAK: 'fail_immediate_circuit_break',
  BEST_EFFORT_LOG_ONLY: 'best_effort_log_only',
  BLOCKING_TRANSACTION_ROLLBACK: 'blocking_transaction_rollback',
};

/**
 * Registry of all cross-service domain event contracts.
 */
export const DOMAIN_EVENT_CONTRACTS = {
  'purchase.settled': {
    eventType: 'purchase.settled',
    domain: DOMAINS.MARKETPLACE,
    schemaVersion: '1.2.0',
    supportedVersions: ['1.0.0', '1.1.0', '1.2.0'],
    producers: [
      {
        service: 'checkout-api',
        entrypoint: 'src/app/api/purchases/checkout/route.js',
        description: 'Emitted when on-chain Stellar transaction settles and payment is verified',
      },
    ],
    consumers: [
      {
        service: 'entitlement-worker',
        handler: 'src/lib/backend/entitlementFlow.js',
        concurrency: 10,
        idempotent: true,
        description: 'Grants downloadable access and persists entitlement cache',
      },
      {
        service: 'payout-accrual-worker',
        handler: 'src/lib/backend/creatorPayouts.js',
        concurrency: 5,
        idempotent: true,
        description: 'Allocates net funds to creator pending balance and platform reserve',
      },
      {
        service: 'analytics-collector',
        handler: 'src/lib/backend/analyticsEvents.js',
        concurrency: 20,
        idempotent: true,
        description: 'Records anonymized purchase metric for creator dashboard and platform stats',
      },
      {
        service: 'email-notifier',
        handler: 'src/lib/email/receiptWorker.js',
        concurrency: 5,
        idempotent: true,
        description: 'Dispatches receipt and download link to buyer email',
      },
    ],
    requiredFields: [
      'purchaseId',
      'materialId',
      'buyerAddress',
      'creatorAddress',
      'amount',
      'currency',
      'txHash',
      'settledAt',
    ],
    fieldTypes: {
      purchaseId: 'string',
      materialId: 'string',
      buyerAddress: 'string',
      creatorAddress: 'string',
      amount: 'number',
      currency: 'string',
      txHash: 'string',
      settledAt: 'string',
    },
    versioningRules: {
      backwardsCompatible: true,
      deprecationsRequireNotice: true,
      ruleSummary: 'Add optional keys only. Never remove purchaseId, amount, or addresses.',
    },
    allowedFailureBehavior: {
      strategy: FAILURE_STRATEGIES.RETRY_THEN_DEAD_LETTER,
      maxRetries: 5,
      backoff: 'exponential',
      initialIntervalMs: 1000,
      maxIntervalMs: 60000,
      deadLetterQueue: 'side_effect_outbox:dead_letter',
      alertOnFailure: true,
      replayable: true,
    },
  },

  'refund.processed': {
    eventType: 'refund.processed',
    domain: DOMAINS.FINANCE,
    schemaVersion: '1.1.0',
    supportedVersions: ['1.0.0', '1.1.0'],
    producers: [
      {
        service: 'refund-api',
        entrypoint: 'src/app/api/admin/refunds/route.js',
        description: 'Emitted when administrator approves or executes a purchase refund',
      },
    ],
    consumers: [
      {
        service: 'entitlement-revoker',
        handler: 'src/lib/backend/entitlementFlow.js',
        concurrency: 5,
        idempotent: true,
        description: 'Revokes buyer access tokens and invalidates cached entitlements',
      },
      {
        service: 'financial-audit-sink',
        handler: 'src/lib/backend/financialAuditLedger.js',
        concurrency: 1,
        idempotent: true,
        description: 'Appends chronological, tamper-evident hash-chained audit record',
      },
      {
        service: 'creator-journal',
        handler: 'src/lib/backend/creatorJournal.js',
        concurrency: 5,
        idempotent: true,
        description: 'Debits creator balance and records refund adjustment entry',
      },
    ],
    requiredFields: [
      'refundId',
      'purchaseId',
      'buyerAddress',
      'creatorAddress',
      'amount',
      'currency',
      'reason',
      'processedAt',
    ],
    fieldTypes: {
      refundId: 'string',
      purchaseId: 'string',
      buyerAddress: 'string',
      creatorAddress: 'string',
      amount: 'number',
      currency: 'string',
      reason: 'string',
      processedAt: 'string',
    },
    versioningRules: {
      backwardsCompatible: true,
      deprecationsRequireNotice: true,
      ruleSummary: 'Strict immutable payload. Additional audit flags must be optional.',
    },
    allowedFailureBehavior: {
      strategy: FAILURE_STRATEGIES.RETRY_THEN_DEAD_LETTER,
      maxRetries: 3,
      backoff: 'exponential',
      initialIntervalMs: 2000,
      maxIntervalMs: 30000,
      deadLetterQueue: 'refunds:dead_letter',
      alertOnFailure: true,
      replayable: true,
    },
  },

  'payout.settled': {
    eventType: 'payout.settled',
    domain: DOMAINS.FINANCE,
    schemaVersion: '1.0.0',
    supportedVersions: ['1.0.0'],
    producers: [
      {
        service: 'payout-worker',
        entrypoint: 'src/lib/backend/creatorPayouts.js',
        description: 'Emitted when creator withdrawal successfully clears on Stellar network',
      },
    ],
    consumers: [
      {
        service: 'financial-audit-sink',
        handler: 'src/lib/backend/financialAuditLedger.js',
        concurrency: 1,
        idempotent: true,
        description: 'Enters payout settlement into immutable hash-chained ledger',
      },
      {
        service: 'notification-worker',
        handler: 'src/lib/backend/outbox.js',
        concurrency: 10,
        idempotent: true,
        description: 'Sends payout settlement email and push notification to creator',
      },
    ],
    requiredFields: [
      'payoutId',
      'creatorAddress',
      'destinationAddress',
      'netAmount',
      'feeAmount',
      'asset',
      'txHash',
      'settledAt',
    ],
    fieldTypes: {
      payoutId: 'string',
      creatorAddress: 'string',
      destinationAddress: 'string',
      netAmount: 'number',
      feeAmount: 'number',
      asset: 'string',
      txHash: 'string',
      settledAt: 'string',
    },
    versioningRules: {
      backwardsCompatible: true,
      deprecationsRequireNotice: true,
      ruleSummary: 'Financial integrity requires exact asset, fee, and txHash preservation.',
    },
    allowedFailureBehavior: {
      strategy: FAILURE_STRATEGIES.RETRY_THEN_DEAD_LETTER,
      maxRetries: 4,
      backoff: 'exponential',
      initialIntervalMs: 1500,
      maxIntervalMs: 45000,
      deadLetterQueue: 'payouts:dead_letter',
      alertOnFailure: true,
      replayable: true,
    },
  },

  'material.published': {
    eventType: 'material.published',
    domain: DOMAINS.CONTENT,
    schemaVersion: '1.3.0',
    supportedVersions: ['1.0.0', '1.1.0', '1.2.0', '1.3.0'],
    producers: [
      {
        service: 'publication-saga',
        entrypoint: 'src/lib/backend/publicationSaga.js',
        description: 'Emitted when educational material passes upload and is published by creator',
      },
    ],
    consumers: [
      {
        service: 'search-projection-indexer',
        handler: 'src/lib/backend/materialSearchProjection.js',
        concurrency: 10,
        idempotent: true,
        description: 'Indexes material document for full-text and faceted search queries',
      },
      {
        service: 'preview-pipeline',
        handler: 'src/lib/backend/previewPipeline.js',
        concurrency: 5,
        idempotent: true,
        description: 'Generates secure thumbnail previews and excerpt watermarks',
      },
      {
        service: 'provenance-logger',
        handler: 'src/lib/backend/provenance.js',
        concurrency: 5,
        idempotent: true,
        description: 'Records origin metadata, import batch references, and content hashes',
      },
    ],
    requiredFields: [
      'materialId',
      'title',
      'creatorAddress',
      'price',
      'category',
      'storageKey',
      'publishedAt',
    ],
    fieldTypes: {
      materialId: 'string',
      title: 'string',
      creatorAddress: 'string',
      price: 'number',
      category: 'string',
      storageKey: 'string',
      publishedAt: 'string',
    },
    versioningRules: {
      backwardsCompatible: true,
      deprecationsRequireNotice: true,
      ruleSummary: 'Search facets can expand. Core price and storageKey schema must be strictly typed.',
    },
    allowedFailureBehavior: {
      strategy: FAILURE_STRATEGIES.RETRY_THEN_DEAD_LETTER,
      maxRetries: 3,
      backoff: 'exponential',
      initialIntervalMs: 1000,
      maxIntervalMs: 20000,
      deadLetterQueue: 'indexer_deadletters',
      alertOnFailure: false,
      replayable: true,
    },
  },

  'material.quarantined': {
    eventType: 'material.quarantined',
    domain: DOMAINS.CONTENT,
    schemaVersion: '1.0.0',
    supportedVersions: ['1.0.0'],
    producers: [
      {
        service: 'upload-guard',
        entrypoint: 'src/lib/backend/archiveUploadGuard.js',
        description: 'Emitted when file scanner or admin review flags content as unsafe',
      },
      {
        service: 'admin-moderation-api',
        entrypoint: 'src/lib/db/adminAudit.js',
        description: 'Emitted when operator takes down or quarantines content',
      },
    ],
    consumers: [
      {
        service: 'search-tombstoner',
        handler: 'src/lib/backend/materialSearchProjection.js',
        concurrency: 10,
        idempotent: true,
        description: 'Immediately removes item from marketplace discovery search index',
      },
      {
        service: 'delivery-blocker',
        handler: 'src/lib/backend/archiveExtractor.js',
        concurrency: 10,
        idempotent: true,
        description: 'Terminates all active and pending download tokens for the file',
      },
      {
        service: 'partial-failure-monitor',
        handler: 'src/lib/backend/partialFailures.js',
        concurrency: 5,
        idempotent: true,
        description: 'Surfaces item in operator partial failure dashboard with creator action guidance',
      },
    ],
    requiredFields: [
      'materialId',
      'creatorAddress',
      'quarantineReason',
      'quarantineState',
      'quarantinedAt',
    ],
    fieldTypes: {
      materialId: 'string',
      creatorAddress: 'string',
      quarantineReason: 'string',
      quarantineState: 'string',
      quarantinedAt: 'string',
    },
    versioningRules: {
      backwardsCompatible: true,
      deprecationsRequireNotice: true,
      ruleSummary: 'Security event. Requires unambiguous quarantineState and reason.',
    },
    allowedFailureBehavior: {
      strategy: FAILURE_STRATEGIES.FAIL_IMMEDIATE_CIRCUIT_BREAK,
      maxRetries: 1,
      backoff: 'fixed',
      initialIntervalMs: 500,
      maxIntervalMs: 1000,
      deadLetterQueue: 'quarantine_urgent_deadletters',
      alertOnFailure: true,
      replayable: true,
    },
  },

  'user.role_changed': {
    eventType: 'user.role_changed',
    domain: DOMAINS.IDENTITY,
    schemaVersion: '1.0.0',
    supportedVersions: ['1.0.0'],
    producers: [
      {
        service: 'admin-iam-api',
        entrypoint: 'src/app/api/admin/roles/route.js',
        description: 'Emitted when user permissions, admin roles, or creator verification changes',
      },
    ],
    consumers: [
      {
        service: 'session-cache-invalidator',
        handler: 'src/lib/auth/session.js',
        concurrency: 5,
        idempotent: true,
        description: 'Evicts active JWT/session claims forcing re-authorization',
      },
      {
        service: 'privileged-audit-sink',
        handler: 'src/lib/backend/financialAuditLedger.js',
        concurrency: 1,
        idempotent: true,
        description: 'Logs role transition to chronological hash-chained audit ledger',
      },
    ],
    requiredFields: [
      'userId',
      'userAddress',
      'previousRole',
      'newRole',
      'modifiedBy',
      'changedAt',
    ],
    fieldTypes: {
      userId: 'string',
      userAddress: 'string',
      previousRole: 'string',
      newRole: 'string',
      modifiedBy: 'string',
      changedAt: 'string',
    },
    versioningRules: {
      backwardsCompatible: true,
      deprecationsRequireNotice: true,
      ruleSummary: 'IAM role change must always state previousRole and newRole explicitly.',
    },
    allowedFailureBehavior: {
      strategy: FAILURE_STRATEGIES.RETRY_THEN_DEAD_LETTER,
      maxRetries: 3,
      backoff: 'exponential',
      initialIntervalMs: 1000,
      maxIntervalMs: 10000,
      deadLetterQueue: 'admin_audit_deadletters',
      alertOnFailure: true,
      replayable: true,
    },
  },

  'indexer.sync_completed': {
    eventType: 'indexer.sync_completed',
    domain: DOMAINS.INDEXER,
    schemaVersion: '1.0.0',
    supportedVersions: ['1.0.0'],
    producers: [
      {
        service: 'stellar-indexer',
        entrypoint: 'scripts/run-stellar-indexer.mjs',
        description: 'Emitted periodically after scanning ledger blocks and processing Soroban events',
      },
    ],
    consumers: [
      {
        service: 'stale-index-detector',
        handler: 'src/lib/backend/staleIndexDetection.js',
        concurrency: 1,
        idempotent: true,
        description: 'Updates last-synced ledger checkpoint and checks for lagging indices',
      },
      {
        service: 'operational-health-monitor',
        handler: 'src/lib/backend/operationalHealth.js',
        concurrency: 1,
        idempotent: true,
        description: 'Records indexer throughput and error rates into system health metric cards',
      },
    ],
    requiredFields: [
      'ledgerSequence',
      'blockTime',
      'eventsProcessed',
      'checkpointCursor',
      'syncedAt',
    ],
    fieldTypes: {
      ledgerSequence: 'number',
      blockTime: 'string',
      eventsProcessed: 'number',
      checkpointCursor: 'string',
      syncedAt: 'string',
    },
    versioningRules: {
      backwardsCompatible: true,
      deprecationsRequireNotice: true,
      ruleSummary: 'Ledger sequence must be integer. High frequency pulse.',
    },
    allowedFailureBehavior: {
      strategy: FAILURE_STRATEGIES.BEST_EFFORT_LOG_ONLY,
      maxRetries: 1,
      backoff: 'fixed',
      initialIntervalMs: 500,
      maxIntervalMs: 1000,
      deadLetterQueue: null,
      alertOnFailure: false,
      replayable: false,
    },
  },
};

/**
 * Validates an event payload against its registered contract.
 *
 * @param {string} eventType
 * @param {object} payload
 * @param {object} [options]
 * @param {string} [options.version]
 * @returns {{ valid: boolean, errors: string[], contract: object|null }}
 */
export function validateEventPayload(eventType, payload, options = {}) {
  const contract = DOMAIN_EVENT_CONTRACTS[eventType];
  if (!contract) {
    return {
      valid: false,
      errors: [`Unknown event type: ${eventType}. No contract registered.`],
      contract: null,
    };
  }

  const errors = [];

  // 1. Version validation
  const requestedVersion = options.version || contract.schemaVersion;
  if (!contract.supportedVersions.includes(requestedVersion)) {
    errors.push(
      `Unsupported schema version ${requestedVersion} for ${eventType}. Supported: ${contract.supportedVersions.join(', ')}`
    );
  }

  // 2. Payload existence
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      errors: ['Event payload must be a non-null object.'],
      contract,
    };
  }

  // 3. Required fields check
  for (const field of contract.requiredFields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      errors.push(`Missing required field: '${field}' for event '${eventType}'`);
      continue;
    }

    // 4. Field type validation
    const expectedType = contract.fieldTypes[field];
    if (expectedType) {
      const actualType = typeof payload[field];
      if (actualType !== expectedType) {
        errors.push(`Invalid type for field '${field}': expected ${expectedType}, received ${actualType}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    contract,
  };
}

/**
 * Get the list of all producers and consumers across all domains.
 */
export function getCrossServiceBoundarySummary() {
  const summary = {
    totalEvents: Object.keys(DOMAIN_EVENT_CONTRACTS).length,
    byDomain: {},
    producers: {},
    consumers: {},
  };

  for (const [eventName, contract] of Object.entries(DOMAIN_EVENT_CONTRACTS)) {
    summary.byDomain[contract.domain] = (summary.byDomain[contract.domain] || 0) + 1;

    for (const prod of contract.producers) {
      if (!summary.producers[prod.service]) {
        summary.producers[prod.service] = [];
      }
      summary.producers[prod.service].push(eventName);
    }

    for (const cons of contract.consumers) {
      if (!summary.consumers[cons.service]) {
        summary.consumers[cons.service] = [];
      }
      summary.consumers[cons.service].push(eventName);
    }
  }

  return summary;
}
