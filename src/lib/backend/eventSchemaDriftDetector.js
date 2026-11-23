/**
 * Cross-Service Event Schema Drift Detection Framework (#1107)
 *
 * Provides runtime and batch schema drift detection for all asynchronous domain events,
 * integration boundaries, and microservice message flows across EduVault.
 *
 * Architectural Design:
 * - Clean boundary validation between event producers (checkout, indexer, upload, etc.)
 *   and event consumers (entitlements, payouts, analytics, notification workers).
 * - Multi-level drift taxonomy:
 *     * NO_DRIFT: Strict compliance with contract.
 *     * ADDITIVE_DRIFT: New non-required fields observed; backward-compatible.
 *     * BREAKING_DRIFT: Missing required fields, type mutation, unsupported version,
 *       or unauthorized producer.
 *     * CONSUMER_INCOMPATIBILITY: Breaking contract changes that violate consumer expectations.
 *
 * Performance Characteristics:
 * - Single-event drift check: O(F) time complexity where F is field count (typically < 30).
 * - Space complexity: O(F) memory footprint for error sets and property arrays.
 * - Batch evaluation: O(N * F) time complexity with single-pass aggregation.
 */

import {
  DOMAIN_EVENT_CONTRACTS,
  DOMAINS,
  FAILURE_STRATEGIES,
} from './eventContractMap.js';

export const DRIFT_SEVERITY = Object.freeze({
  NONE: 'none',
  WARNING: 'warning',
  CRITICAL: 'critical',
});

export const DRIFT_TYPES = Object.freeze({
  NO_DRIFT: 'no_drift',
  UNKNOWN_EVENT: 'unknown_event',
  UNSUPPORTED_VERSION: 'unsupported_version',
  MISSING_REQUIRED_FIELD: 'missing_required_field',
  TYPE_MISMATCH: 'type_mismatch',
  ADDITIVE_FIELD: 'additive_field',
  PRODUCER_UNAUTHORIZED: 'producer_unauthorized',
  CONSUMER_INCOMPATIBLE: 'consumer_incompatible',
  CONTRACT_BREAKING_CHANGE: 'contract_breaking_change',
});

export class DriftAuthorizationError extends Error {
  constructor(message = 'Unauthorized schema drift operation.') {
    super(message);
    this.name = 'DriftAuthorizationError';
    this.status = 403;
  }
}

export class DriftValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DriftValidationError';
    this.status = 400;
    this.details = details;
  }
}

/**
 * Validates a single event against registered contracts and checks for schema drift.
 *
 * @param {object} event
 * @param {string} event.eventType
 * @param {object} event.payload
 * @param {string} [event.schemaVersion]
 * @param {string} [event.producerService]
 * @param {object} [options]
 * @param {boolean} [options.allowAdditive=true]
 * @param {string[]} [options.enforceConsumers]
 * @returns {object} Drift detection result
 */
export function detectEventDrift(event, options = {}) {
  const { allowAdditive = true, enforceConsumers = [] } = options;

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return {
      drifted: true,
      severity: DRIFT_SEVERITY.CRITICAL,
      driftTypes: [DRIFT_TYPES.UNKNOWN_EVENT],
      violations: ['Event record must be a non-null object.'],
      eventType: null,
      producerService: null,
      contract: null,
    };
  }

  const { eventType, payload, schemaVersion, producerService } = event;

  if (!eventType || typeof eventType !== 'string') {
    return {
      drifted: true,
      severity: DRIFT_SEVERITY.CRITICAL,
      driftTypes: [DRIFT_TYPES.UNKNOWN_EVENT],
      violations: ['Missing or invalid "eventType" string.'],
      eventType: null,
      producerService: producerService || null,
      contract: null,
    };
  }

  const contract = DOMAIN_EVENT_CONTRACTS[eventType];
  if (!contract) {
    return {
      drifted: true,
      severity: DRIFT_SEVERITY.CRITICAL,
      driftTypes: [DRIFT_TYPES.UNKNOWN_EVENT],
      violations: [`Unregistered event type "${eventType}". No contract found in registry.`],
      eventType,
      producerService: producerService || null,
      contract: null,
    };
  }

  const violations = [];
  const driftTypes = new Set();
  let severity = DRIFT_SEVERITY.NONE;

  // 1. Version Drift Detection
  const version = schemaVersion || payload?.schemaVersion || contract.schemaVersion;
  if (!contract.supportedVersions.includes(version)) {
    violations.push(
      `Unsupported schema version "${version}" for "${eventType}". Supported: [${contract.supportedVersions.join(', ')}]`
    );
    driftTypes.add(DRIFT_TYPES.UNSUPPORTED_VERSION);
    severity = DRIFT_SEVERITY.CRITICAL;
  }

  // 2. Producer Authorization / Registration Check
  if (producerService) {
    const isRegisteredProducer = contract.producers.some(
      (p) => p.service.toLowerCase() === producerService.toLowerCase()
    );
    if (!isRegisteredProducer) {
      violations.push(
        `Producer service "${producerService}" is not registered to emit "${eventType}". Registered: [${contract.producers.map((p) => p.service).join(', ')}]`
      );
      driftTypes.add(DRIFT_TYPES.PRODUCER_UNAUTHORIZED);
      severity = DRIFT_SEVERITY.CRITICAL;
    }
  }

  // 3. Payload Integrity
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    violations.push('Payload must be a non-null JSON object.');
    driftTypes.add(DRIFT_TYPES.MISSING_REQUIRED_FIELD);
    return {
      drifted: true,
      severity: DRIFT_SEVERITY.CRITICAL,
      driftTypes: Array.from(driftTypes),
      violations,
      eventType,
      producerService: producerService || null,
      contract,
    };
  }

  // 4. Missing Required Fields Check
  for (const field of contract.requiredFields) {
    const val = payload[field];
    if (val === undefined || val === null || val === '') {
      violations.push(`Missing required field: "${field}"`);
      driftTypes.add(DRIFT_TYPES.MISSING_REQUIRED_FIELD);
      severity = DRIFT_SEVERITY.CRITICAL;
    }
  }

  // 5. Type Consistency Check
  for (const [field, expectedType] of Object.entries(contract.fieldTypes || {})) {
    if (payload[field] !== undefined && payload[field] !== null) {
      const actualType = typeof payload[field];
      if (actualType !== expectedType) {
        violations.push(
          `Field "${field}" type mismatch: expected ${expectedType}, received ${actualType}`
        );
        driftTypes.add(DRIFT_TYPES.TYPE_MISMATCH);
        severity = DRIFT_SEVERITY.CRITICAL;
      }
    }
  }

  // 6. Additive Field Detection (Forward-compatibility warning)
  const declaredFields = new Set([
    ...contract.requiredFields,
    ...Object.keys(contract.fieldTypes || {}),
    'schemaVersion',
    'id',
    '_id',
    'timestamp',
    'occurredAt',
  ]);

  const additiveFields = Object.keys(payload).filter((k) => !declaredFields.has(k));
  if (additiveFields.length > 0) {
    if (!allowAdditive) {
      violations.push(`Undeclared additive fields present in strict mode: [${additiveFields.join(', ')}]`);
      driftTypes.add(DRIFT_TYPES.ADDITIVE_FIELD);
      severity = DRIFT_SEVERITY.CRITICAL;
    } else {
      violations.push(`Additive fields detected (non-breaking): [${additiveFields.join(', ')}]`);
      driftTypes.add(DRIFT_TYPES.ADDITIVE_FIELD);
      if (severity !== DRIFT_SEVERITY.CRITICAL) {
        severity = DRIFT_SEVERITY.WARNING;
      }
    }
  }

  // 7. Consumer Incompatibility Check
  const targetConsumers = enforceConsumers.length > 0
    ? contract.consumers.filter((c) => enforceConsumers.includes(c.service))
    : contract.consumers;

  const incompatibleConsumers = [];
  for (const consumer of targetConsumers) {
    if (severity === DRIFT_SEVERITY.CRITICAL) {
      incompatibleConsumers.push({
        service: consumer.service,
        handler: consumer.handler,
        reason: 'Event has breaking schema drift.',
      });
    }
  }

  if (incompatibleConsumers.length > 0) {
    driftTypes.add(DRIFT_TYPES.CONSUMER_INCOMPATIBLE);
  }

  const drifted = violations.length > 0;
  if (!drifted) {
    driftTypes.add(DRIFT_TYPES.NO_DRIFT);
  }

  return {
    drifted,
    severity,
    driftTypes: Array.from(driftTypes),
    violations,
    additiveFields,
    eventType,
    producerService: producerService || null,
    incompatibleConsumers,
    contract: {
      eventType: contract.eventType,
      domain: contract.domain,
      schemaVersion: contract.schemaVersion,
      failureStrategy: contract.allowedFailureBehavior?.strategy,
    },
  };
}

/**
 * Evaluates a batch of event payloads for schema drift.
 * Time complexity: O(N * F), Space complexity: O(N + F).
 *
 * @param {object[]} events
 * @param {object} [options]
 * @returns {object} Batch drift detection summary
 */
export function detectBatchDrift(events = [], options = {}) {
  const { failFast = false, allowAdditive = true } = options;

  if (!Array.isArray(events)) {
    throw new DriftValidationError('Events parameter must be an array.');
  }

  const summary = {
    totalEvents: events.length,
    cleanEvents: 0,
    warningEvents: 0,
    criticalEvents: 0,
    byEventType: {},
    byProducer: {},
    driftDetails: [],
  };

  for (let i = 0; i < events.length; i += 1) {
    const item = events[i];
    const result = detectEventDrift(item, { allowAdditive });

    const eventName = item?.eventType || 'unknown';
    summary.byEventType[eventName] = (summary.byEventType[eventName] || 0) + 1;

    const producer = item?.producerService || 'unknown';
    summary.byProducer[producer] = (summary.byProducer[producer] || 0) + 1;

    if (!result.drifted) {
      summary.cleanEvents += 1;
    } else if (result.severity === DRIFT_SEVERITY.WARNING) {
      summary.warningEvents += 1;
      summary.driftDetails.push({ index: i, ...result });
    } else {
      summary.criticalEvents += 1;
      summary.driftDetails.push({ index: i, ...result });
      if (failFast) break;
    }
  }

  return {
    ok: summary.criticalEvents === 0,
    summary,
  };
}

/**
 * Validates schema evolution between a baseline contract and candidate contract
 * to detect breaking changes before contracts are published or updated.
 *
 * @param {object} baseContract
 * @param {object} candidateContract
 * @returns {object} Evolution drift analysis
 */
export function detectContractEvolutionDrift(baseContract, candidateContract) {
  if (!baseContract || !candidateContract) {
    throw new DriftValidationError('Both baseContract and candidateContract are required for evolution check.');
  }

  const breakingChanges = [];
  const nonBreakingChanges = [];

  // Check required fields: removing a required field or adding a new required field
  const baseReq = new Set(baseContract.requiredFields || []);
  const candReq = new Set(candidateContract.requiredFields || []);

  for (const field of candReq) {
    if (!baseReq.has(field)) {
      // New required field in candidate contract is breaking for existing publishers
      breakingChanges.push(`New required field "${field}" introduced without backward fallback.`);
    }
  }

  for (const field of baseReq) {
    if (!candReq.has(field)) {
      nonBreakingChanges.push(`Field "${field}" is no longer required.`);
    }
  }

  // Check type changes
  const baseTypes = baseContract.fieldTypes || {};
  const candTypes = candidateContract.fieldTypes || {};

  for (const [field, expectedType] of Object.entries(baseTypes)) {
    if (candTypes[field] && candTypes[field] !== expectedType) {
      breakingChanges.push(
        `Field "${field}" type mutated from "${expectedType}" to "${candTypes[field]}".`
      );
    }
  }

  // Check supported versions
  const baseVers = new Set(baseContract.supportedVersions || []);
  const candVers = new Set(candidateContract.supportedVersions || []);

  for (const ver of baseVers) {
    if (!candVers.has(ver)) {
      breakingChanges.push(`Previously supported schema version "${ver}" was deprecated/dropped.`);
    }
  }

  const isBreaking = breakingChanges.length > 0;

  return {
    isBreaking,
    severity: isBreaking ? DRIFT_SEVERITY.CRITICAL : (nonBreakingChanges.length > 0 ? DRIFT_SEVERITY.WARNING : DRIFT_SEVERITY.NONE),
    breakingChanges,
    nonBreakingChanges,
  };
}

/**
 * Remediation dispatcher for events with detected schema drift.
 * Supports quarantine, dead_letter, accept_additive, or retry.
 *
 * Authorization: Only 'admin' or 'operator' roles can reconcile schema drift.
 *
 * @param {object} params
 * @param {object} params.db
 * @param {object} params.event
 * @param {object} params.driftResult
 * @param {string} params.action - 'quarantine' | 'dead_letter' | 'accept_additive' | 'retry'
 * @param {object} params.actor - Authenticated user/actor
 * @param {string} [params.reason]
 * @returns {Promise<object>} Remediation record
 */
export async function reconcileSchemaDrift({
  db,
  event,
  driftResult,
  action,
  actor,
  reason = 'Schema drift remediation',
  now = new Date(),
}) {
  const role = actor?.role;
  if (role !== 'admin' && role !== 'operator') {
    throw new DriftAuthorizationError('Only an admin or operator may execute schema drift remediation.');
  }

  const validActions = new Set(['quarantine', 'dead_letter', 'accept_additive', 'retry']);
  if (!validActions.has(action)) {
    throw new DriftValidationError(`Invalid remediation action: "${action}". Must be one of [quarantine, dead_letter, accept_additive, retry].`);
  }

  const record = {
    driftId: `drift-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    eventType: event?.eventType || 'unknown',
    action,
    actor: actor?.id || actor?.walletAddress || 'operator',
    reason,
    violations: driftResult?.violations || [],
    severity: driftResult?.severity || DRIFT_SEVERITY.CRITICAL,
    remediatedAt: now,
    status: action === 'retry' ? 'pending_retry' : 'resolved',
  };

  if (db && typeof db.collection === 'function') {
    await db.collection('event_schema_drift_remediations').insertOne(record);
  }

  return record;
}

