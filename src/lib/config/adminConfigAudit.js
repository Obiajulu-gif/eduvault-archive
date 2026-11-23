/**
 * src/lib/config/adminConfigAudit.js
 *
 * Audit evidence system for administrative configuration changes (#1001).
 *
 * Provides:
 * 1. Declarative setting registry with type checking, value bounds, severity classification,
 *    dual-approval enforcement (two-person rule), and secret masking.
 * 2. Cryptographically signed, tamper-evident evidence envelopes with SHA-256 canonical hashing,
 *    actor commitment proofs, and previous-hash chaining (blockchain-style ledger).
 * 3. Normal, failure, retry (idempotent), and authorization paths.
 * 4. Chain integrity verification with gap, mutation, and tampering detection.
 * 5. Append-only configuration rollback with forward-linked recovery evidence.
 * 6. Privacy-preserving verifiable evidence export bundles.
 */

import crypto from 'node:crypto';
import { canonicalize } from '../canonical.js';
import { COLLECTIONS } from '../backend/schemaContracts.js';

export const CONFIG_AUDIT_SCHEMA_VERSION = 1;
export const GENESIS_PREV_HASH = '0'.repeat(64);
export const DEFAULT_AUDIT_SIGNING_KEY =
  process.env.CONFIG_AUDIT_SIGNING_KEY ||
  process.env.EVIDENCE_BUNDLE_KEY ||
  'eduvault-config-audit-default-key-32b';

export const CONFIG_AUDIT_CHANGE_TYPES = Object.freeze({
  UPDATE: 'CONFIG_UPDATE',
  RESET: 'CONFIG_RESET',
  ROLLBACK: 'CONFIG_ROLLBACK',
});

export const CONFIG_AUDIT_CATEGORIES = Object.freeze({
  MARKETPLACE: 'marketplace',
  SECURITY: 'security',
  FEATURE_FLAGS: 'feature_flags',
  MAINTENANCE: 'maintenance',
  STORAGE: 'storage',
  FINANCIAL: 'financial',
  SYSTEM: 'system',
});

export const CONFIG_AUDIT_SEVERITY = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

/**
 * Structured error class for administrative configuration audit operations.
 */
export class ConfigAuditError extends Error {
  constructor(message, code = 'CONFIG_AUDIT_ERROR', status = 400, details = null) {
    super(message);
    this.name = 'ConfigAuditError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Patterns identifying secrets requiring automatic redaction in evidence snapshots
const SECRET_SHAPES = [
  /\bS[A-Z2-7]{55}\b/, // Stellar secret seed
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
];

/**
 * Declarative configuration setting registry.
 * Each setting specifies category, expected type, validation rules, severity, and whether
 * high-impact changes require secondary maintainer approval (dual-approval / two-person rule).
 */
export const CONFIG_SETTING_REGISTRY = Object.freeze({
  // Marketplace settings
  'marketplace.platformFeeBps': {
    category: CONFIG_AUDIT_CATEGORIES.MARKETPLACE,
    type: 'integer',
    min: 0,
    max: 10000,
    defaultValue: 250, // 2.5%
    severity: CONFIG_AUDIT_SEVERITY.CRITICAL,
    dualApprovalRequired: true,
    description: 'Platform fee basis points on marketplace purchases (0 - 10000).',
  },
  'marketplace.creatorShareBps': {
    category: CONFIG_AUDIT_CATEGORIES.MARKETPLACE,
    type: 'integer',
    min: 0,
    max: 10000,
    defaultValue: 9750, // 97.5%
    severity: CONFIG_AUDIT_SEVERITY.HIGH,
    dualApprovalRequired: false,
    description: 'Default creator revenue share in basis points (0 - 10000).',
  },
  'marketplace.maxBatchSize': {
    category: CONFIG_AUDIT_CATEGORIES.MARKETPLACE,
    type: 'integer',
    min: 1,
    max: 1000,
    defaultValue: 100,
    severity: CONFIG_AUDIT_SEVERITY.LOW,
    dualApprovalRequired: false,
    description: 'Maximum item batch size for bulk marketplace operations.',
  },

  // Financial & payout settings
  'financial.maxPayoutPerTx': {
    category: CONFIG_AUDIT_CATEGORIES.FINANCIAL,
    type: 'number',
    min: 0.01,
    max: 1000000,
    defaultValue: 10000,
    severity: CONFIG_AUDIT_SEVERITY.CRITICAL,
    dualApprovalRequired: true,
    description: 'Maximum permitted payout amount per transaction.',
  },
  'financial.payoutHoldPeriodHours': {
    category: CONFIG_AUDIT_CATEGORIES.FINANCIAL,
    type: 'integer',
    min: 0,
    max: 720, // 30 days
    defaultValue: 72,
    severity: CONFIG_AUDIT_SEVERITY.MEDIUM,
    dualApprovalRequired: false,
    description: 'Mandatory dispute hold period in hours before creator payout release.',
  },
  'financial.minimumPayoutThreshold': {
    category: CONFIG_AUDIT_CATEGORIES.FINANCIAL,
    type: 'number',
    min: 0,
    max: 10000,
    defaultValue: 10,
    severity: CONFIG_AUDIT_SEVERITY.MEDIUM,
    dualApprovalRequired: false,
    description: 'Minimum balance threshold required to initiate a payout.',
  },

  // Security settings
  'security.sessionInactivityTimeoutMinutes': {
    category: CONFIG_AUDIT_CATEGORIES.SECURITY,
    type: 'integer',
    min: 5,
    max: 1440, // 24 hours
    defaultValue: 60,
    severity: CONFIG_AUDIT_SEVERITY.HIGH,
    dualApprovalRequired: false,
    description: 'Inactivity duration in minutes before user sessions expire.',
  },
  'security.tokenRevocationGraceSeconds': {
    category: CONFIG_AUDIT_CATEGORIES.SECURITY,
    type: 'integer',
    min: 0,
    max: 3600,
    defaultValue: 300,
    severity: CONFIG_AUDIT_SEVERITY.HIGH,
    dualApprovalRequired: false,
    description: 'Grace period in seconds for in-flight requests during token family rotation.',
  },
  'security.maxFailedLoginAttempts': {
    category: CONFIG_AUDIT_CATEGORIES.SECURITY,
    type: 'integer',
    min: 1,
    max: 20,
    defaultValue: 5,
    severity: CONFIG_AUDIT_SEVERITY.MEDIUM,
    dualApprovalRequired: false,
    description: 'Consecutive failed login threshold triggering temporary account lockout.',
  },

  // Feature flags
  'feature_flags.stellar_indexer': {
    category: CONFIG_AUDIT_CATEGORIES.FEATURE_FLAGS,
    type: 'boolean',
    defaultValue: true,
    severity: CONFIG_AUDIT_SEVERITY.MEDIUM,
    dualApprovalRequired: false,
    description: 'Enable live Stellar / Soroban event ingestion worker.',
  },
  'feature_flags.bulk_refunds': {
    category: CONFIG_AUDIT_CATEGORIES.FEATURE_FLAGS,
    type: 'boolean',
    defaultValue: false,
    severity: CONFIG_AUDIT_SEVERITY.HIGH,
    dualApprovalRequired: false,
    description: 'Enable bulk refund processing capabilities.',
  },
  'feature_flags.learner_export': {
    category: CONFIG_AUDIT_CATEGORIES.FEATURE_FLAGS,
    type: 'boolean',
    defaultValue: true,
    severity: CONFIG_AUDIT_SEVERITY.LOW,
    dualApprovalRequired: false,
    description: 'Enable learner self-service data export archives.',
  },
  'feature_flags.soroban_smart_contracts': {
    category: CONFIG_AUDIT_CATEGORIES.FEATURE_FLAGS,
    type: 'boolean',
    defaultValue: true,
    severity: CONFIG_AUDIT_SEVERITY.HIGH,
    dualApprovalRequired: false,
    description: 'Enable on-chain Soroban contract settlement integration.',
  },

  // Maintenance mode
  'maintenance.global': {
    category: CONFIG_AUDIT_CATEGORIES.MAINTENANCE,
    type: 'boolean',
    defaultValue: false,
    severity: CONFIG_AUDIT_SEVERITY.HIGH,
    dualApprovalRequired: false,
    description: 'Global maintenance mode flag blocking non-admin mutations.',
  },
  'maintenance.scope': {
    category: CONFIG_AUDIT_CATEGORIES.MAINTENANCE,
    type: 'string',
    allowedValues: ['global', 'marketplace', 'upload', 'checkout', 'dashboard'],
    defaultValue: 'global',
    severity: CONFIG_AUDIT_SEVERITY.MEDIUM,
    dualApprovalRequired: false,
    description: 'Scope boundary for maintenance mode restriction.',
  },
  'maintenance.message': {
    category: CONFIG_AUDIT_CATEGORIES.MAINTENANCE,
    type: 'string',
    maxLength: 500,
    defaultValue: 'System is undergoing scheduled maintenance.',
    severity: CONFIG_AUDIT_SEVERITY.LOW,
    dualApprovalRequired: false,
    description: 'User-facing banner message displayed during maintenance.',
  },

  // Storage and data retention
  'storage.permanentPurgeRetentionDays': {
    category: CONFIG_AUDIT_CATEGORIES.STORAGE,
    type: 'integer',
    min: 1,
    max: 3650, // 10 years
    defaultValue: 90,
    severity: CONFIG_AUDIT_SEVERITY.CRITICAL,
    dualApprovalRequired: true,
    description: 'Data retention threshold in days before soft-deleted archives are permanently purged.',
  },
  'storage.maxUploadSizeBytes': {
    category: CONFIG_AUDIT_CATEGORIES.STORAGE,
    type: 'integer',
    min: 1024,
    max: 10737418240, // 10 GB
    defaultValue: 524288000, // 500 MB
    severity: CONFIG_AUDIT_SEVERITY.MEDIUM,
    dualApprovalRequired: false,
    description: 'Maximum allowable file size in bytes for material uploads.',
  },
  'storage.quarantineRetentionDays': {
    category: CONFIG_AUDIT_CATEGORIES.STORAGE,
    type: 'integer',
    min: 1,
    max: 365,
    defaultValue: 30,
    severity: CONFIG_AUDIT_SEVERITY.LOW,
    dualApprovalRequired: false,
    description: 'Retention period for quarantined files awaiting virus / integrity clearance.',
  },
});

/**
 * Validates a setting key and proposed value against registry rules.
 * Supports known registry settings or well-formed custom keys (e.g. `custom.<category>.<name>`).
 */
export function validateConfigSetting(settingKey, value) {
  if (!settingKey || typeof settingKey !== 'string') {
    throw new ConfigAuditError('settingKey must be a non-empty string.', 'INVALID_SETTING_KEY', 400);
  }

  const trimmedKey = settingKey.trim();
  const rule = CONFIG_SETTING_REGISTRY[trimmedKey];

  // If known registered setting
  if (rule) {
    validateValueAgainstRule(trimmedKey, value, rule);
    return {
      settingKey: trimmedKey,
      category: rule.category,
      severity: rule.severity,
      dualApprovalRequired: Boolean(rule.dualApprovalRequired),
      rule,
    };
  }

  // If custom setting: must adhere to namespaced format `custom.<category>.<name>`
  const customPattern = /^custom\.([a-z0-9_-]+)\.([a-z0-9_-]+)$/i;
  const match = trimmedKey.match(customPattern);
  if (!match) {
    throw new ConfigAuditError(
      `Unknown settingKey: "${trimmedKey}". Custom settings must match format "custom.<category>.<name>".`,
      'UNKNOWN_SETTING_KEY',
      400,
      { validKnownKeys: Object.keys(CONFIG_SETTING_REGISTRY) }
    );
  }

  if (value === undefined || value === null) {
    throw new ConfigAuditError(`Value cannot be null or undefined for ${trimmedKey}.`, 'INVALID_CONFIG_VALUE', 400);
  }

  const category = match[1].toLowerCase();
  return {
    settingKey: trimmedKey,
    category: Object.values(CONFIG_AUDIT_CATEGORIES).includes(category) ? category : CONFIG_AUDIT_CATEGORIES.SYSTEM,
    severity: CONFIG_AUDIT_SEVERITY.MEDIUM,
    dualApprovalRequired: false,
    rule: null,
  };
}

function validateValueAgainstRule(settingKey, value, rule) {
  if (value === undefined || value === null) {
    throw new ConfigAuditError(`Value cannot be null or undefined for "${settingKey}".`, 'INVALID_CONFIG_VALUE', 400);
  }

  switch (rule.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new ConfigAuditError(`Value for "${settingKey}" must be a boolean.`, 'INVALID_CONFIG_TYPE', 400);
      }
      break;

    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ConfigAuditError(`Value for "${settingKey}" must be an integer.`, 'INVALID_CONFIG_TYPE', 400);
      }
      if (rule.min !== undefined && value < rule.min) {
        throw new ConfigAuditError(
          `Value ${value} for "${settingKey}" is below minimum allowable ${rule.min}.`,
          'CONFIG_VALUE_OUT_OF_BOUNDS',
          400
        );
      }
      if (rule.max !== undefined && value > rule.max) {
        throw new ConfigAuditError(
          `Value ${value} for "${settingKey}" exceeds maximum allowable ${rule.max}.`,
          'CONFIG_VALUE_OUT_OF_BOUNDS',
          400
        );
      }
      break;

    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ConfigAuditError(`Value for "${settingKey}" must be a finite number.`, 'INVALID_CONFIG_TYPE', 400);
      }
      if (rule.min !== undefined && value < rule.min) {
        throw new ConfigAuditError(
          `Value ${value} for "${settingKey}" is below minimum allowable ${rule.min}.`,
          'CONFIG_VALUE_OUT_OF_BOUNDS',
          400
        );
      }
      if (rule.max !== undefined && value > rule.max) {
        throw new ConfigAuditError(
          `Value ${value} for "${settingKey}" exceeds maximum allowable ${rule.max}.`,
          'CONFIG_VALUE_OUT_OF_BOUNDS',
          400
        );
      }
      break;

    case 'string':
      if (typeof value !== 'string') {
        throw new ConfigAuditError(`Value for "${settingKey}" must be a string.`, 'INVALID_CONFIG_TYPE', 400);
      }
      if (rule.allowedValues && !rule.allowedValues.includes(value)) {
        throw new ConfigAuditError(
          `Invalid string value "${value}" for "${settingKey}". Allowed: ${rule.allowedValues.join(', ')}.`,
          'CONFIG_VALUE_NOT_ALLOWED',
          400
        );
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        throw new ConfigAuditError(
          `Value length for "${settingKey}" exceeds maximum ${rule.maxLength} characters.`,
          'CONFIG_VALUE_TOO_LONG',
          400
        );
      }
      break;

    default:
      break;
  }
}

/**
 * Sanitizes and masks sensitive strings or embedded credentials in configuration snapshots.
 */
export function maskSensitiveConfigValue(key, value) {
  if (value === undefined || value === null) return value;

  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveConfigValue(key, item));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = maskSensitiveConfigValue(k, v);
    }
    return out;
  }

  // Direct secret detection on key name for primitive values
  if (/secret|token|password|key|jwt|seed|credential/i.test(key) && !/contractid|publickey/i.test(key)) {
    return '[REDACTED:secret]';
  }

  if (typeof value === 'string') {
    for (const pattern of SECRET_SHAPES) {
      if (pattern.test(value)) {
        return '[REDACTED:secret]';
      }
    }
    return value;
  }

  return value;
}

/**
 * Computes deterministic actor proof binding actor details to the specific configuration change.
 */
export function computeActorProof(actor, settingKey, operationId, signingKey = DEFAULT_AUDIT_SIGNING_KEY) {
  const actorId = String(actor.id || actor.sub || actor);
  const actorRole = String(actor.role || 'admin');
  const payload = {
    actorId,
    actorRole,
    settingKey: String(settingKey),
    operationId: String(operationId),
  };
  return crypto.createHmac('sha256', signingKey).update(canonicalize(payload)).digest('hex');
}

/**
 * Pure generator: constructs a cryptographically bound evidence envelope for a configuration change.
 */
export function buildConfigAuditEvidence({
  evidenceId,
  operationId,
  sequence,
  previousEvidenceHash = GENESIS_PREV_HASH,
  settingKey,
  category,
  changeType = CONFIG_AUDIT_CHANGE_TYPES.UPDATE,
  severity = CONFIG_AUDIT_SEVERITY.MEDIUM,
  before,
  after,
  actor,
  reason,
  approvalEvidence = null,
  targetEvidenceId = null,
  signingKey = DEFAULT_AUDIT_SIGNING_KEY,
  now = new Date(),
}) {
  if (!operationId) throw new ConfigAuditError('operationId is required.', 'MISSING_OPERATION_ID', 400);
  if (!settingKey) throw new ConfigAuditError('settingKey is required.', 'MISSING_SETTING_KEY', 400);
  if (!actor) throw new ConfigAuditError('actor is required.', 'MISSING_ACTOR', 401);
  if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
    throw new ConfigAuditError(
      'A meaningful justification reason (min 5 chars) is mandatory for administrative configuration changes.',
      'MISSING_AUDIT_REASON',
      400
    );
  }

  const generatedEvidenceId =
    evidenceId || `ev_cfg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();

  const sanitizedBefore = maskSensitiveConfigValue(settingKey, before);
  const sanitizedAfter = maskSensitiveConfigValue(settingKey, after);

  const actorDetails = {
    id: String(actor.id || actor.sub || actor),
    role: String(actor.role || 'admin'),
    walletAddress: actor.walletAddress || null,
  };

  const actorProof = computeActorProof(actorDetails, settingKey, operationId, signingKey);

  const unsignedEnvelope = {
    schemaVersion: CONFIG_AUDIT_SCHEMA_VERSION,
    evidenceId: generatedEvidenceId,
    operationId: String(operationId),
    sequence: Number(sequence),
    previousEvidenceHash: String(previousEvidenceHash),
    settingKey: String(settingKey),
    category: String(category),
    changeType: String(changeType),
    severity: String(severity),
    before: sanitizedBefore,
    after: sanitizedAfter,
    diff: {
      from: sanitizedBefore,
      to: sanitizedAfter,
    },
    actor: actorDetails,
    actorProof,
    reason: reason.trim(),
    approvalEvidence: approvalEvidence
      ? {
          approver: String(approvalEvidence.approver),
          approvedAt: approvalEvidence.approvedAt || createdAt,
          reason: String(approvalEvidence.reason || 'Approved'),
          approvalToken: approvalEvidence.approvalToken || null,
        }
      : null,
    targetEvidenceId: targetEvidenceId || null,
    status: 'applied',
    createdAt,
  };

  const canonicalPayload = canonicalize(unsignedEnvelope);
  const recordHash = crypto.createHash('sha256').update(canonicalPayload).digest('hex');
  const signature = crypto.createHmac('sha256', signingKey).update(recordHash).digest('hex');

  return {
    ...unsignedEnvelope,
    recordHash,
    signature,
  };
}

/**
 * Verifies the cryptographic integrity, digest, actor proof, and signature of a single evidence entry.
 */
export function verifyConfigAuditEvidence(
  evidence,
  { signingKey = DEFAULT_AUDIT_SIGNING_KEY, previousEvidence = null } = {}
) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object') {
    return { valid: false, errors: ['invalid_evidence_envelope'] };
  }

  const { recordHash, signature, ...unsigned } = evidence;

  if (!recordHash || typeof recordHash !== 'string' || recordHash.length !== 64) {
    errors.push('missing_or_invalid_record_hash');
  }

  if (!signature || typeof signature !== 'string') {
    errors.push('missing_or_invalid_signature');
  }

  // Re-canonicalize and recompute hash
  try {
    const recomputedHash = crypto.createHash('sha256').update(canonicalize(unsigned)).digest('hex');
    if (recomputedHash !== recordHash) {
      errors.push('record_hash_mismatch');
    }
  } catch (err) {
    errors.push(`canonicalization_failed: ${err.message}`);
  }

  // Verify HMAC signature
  try {
    const expectedSig = crypto.createHmac('sha256', signingKey).update(recordHash).digest('hex');
    if (expectedSig !== signature) {
      errors.push('signature_mismatch');
    }
  } catch {
    errors.push('signature_verification_failed');
  }

  // Verify actor proof
  if (unsigned.actor && unsigned.actorProof) {
    const expectedProof = computeActorProof(
      unsigned.actor,
      unsigned.settingKey,
      unsigned.operationId,
      signingKey
    );
    if (expectedProof !== unsigned.actorProof) {
      errors.push('actor_proof_mismatch');
    }
  } else {
    errors.push('missing_actor_or_proof');
  }

  // Check previous evidence hash linkage if previous record was supplied
  if (previousEvidence) {
    if (unsigned.previousEvidenceHash !== previousEvidence.recordHash) {
      errors.push(
        `chain_broken: expected previousEvidenceHash ${previousEvidence.recordHash}, found ${unsigned.previousEvidenceHash}`
      );
    }
    if (unsigned.sequence !== previousEvidence.sequence + 1) {
      errors.push(`sequence_gap: expected sequence ${previousEvidence.sequence + 1}, found ${unsigned.sequence}`);
    }
  } else if (unsigned.sequence === 0 && unsigned.previousEvidenceHash !== GENESIS_PREV_HASH) {
    errors.push('genesis_previous_hash_mismatch');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates an entire ordered chain of configuration audit evidence entries.
 * Detects gaps, sequence skips, chain breaks, out-of-order records, and internal tampering.
 */
export function verifyConfigAuditChain(records, { signingKey = DEFAULT_AUDIT_SIGNING_KEY } = {}) {
  if (!Array.isArray(records)) {
    return { valid: false, recordsCount: 0, brokenAtSequence: null, errors: ['records_must_be_an_array'] };
  }

  if (records.length === 0) {
    return { valid: true, recordsCount: 0, brokenAtSequence: null, errors: [] };
  }

  let previousRecord = null;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    // Sequence continuity check
    if (record.sequence !== i) {
      return {
        valid: false,
        recordsCount: records.length,
        brokenAtSequence: record.sequence ?? i,
        errors: [`sequence_gap_at_index_${i}: expected sequence ${i}, found ${record.sequence}`],
      };
    }

    const check = verifyConfigAuditEvidence(record, { signingKey, previousEvidence: previousRecord });
    if (!check.valid) {
      return {
        valid: false,
        recordsCount: records.length,
        brokenAtSequence: record.sequence,
        errors: check.errors,
      };
    }

    previousRecord = record;
  }

  return {
    valid: true,
    recordsCount: records.length,
    brokenAtSequence: null,
    errors: [],
  };
}

/**
 * Resolves the MongoDB database instance dynamically or uses the provided mock.
 */
async function resolveDb(injectedDb) {
  if (injectedDb) return injectedDb;
  const { getDb } = await import('../mongodb.js');
  return getDb();
}

/**
 * Main mutating function: applies an administrative configuration change with full audit evidence.
 *
 * Implements:
 * - Authorization validation (admin role required)
 * - Invariant & bounds checking
 * - Dual-approval enforcement on high-impact / CRITICAL changes
 * - Two-person integrity (prevents self-approval)
 * - Idempotent replay on retry (returns existing evidence and configuration)
 * - Optimistic sequence conflict resolution for concurrent writers
 * - Atomicity: Active configuration is NOT updated if writing evidence fails
 */
export async function applyAdminConfigChange({
  db: injectedDb,
  operationId,
  settingKey,
  proposedValue,
  actor,
  reason,
  approvalEvidence = null,
  signingKey = DEFAULT_AUDIT_SIGNING_KEY,
  now = new Date(),
}) {
  // 1. Authorization check
  if (!actor || actor.role !== 'admin') {
    throw new ConfigAuditError(
      'Unauthorized. Administrative privileges required to modify system configuration.',
      'UNAUTHORIZED_ADMIN',
      403
    );
  }

  // 2. Validate setting & proposed value
  const settingMeta = validateConfigSetting(settingKey, proposedValue);
  const normalizedKey = settingMeta.settingKey;

  // 3. Mandatory justification reason
  if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
    throw new ConfigAuditError(
      'A valid justification reason (minimum 5 characters) is mandatory.',
      'MISSING_AUDIT_REASON',
      400
    );
  }

  // 4. Dual-approval enforcement for CRITICAL changes
  if (settingMeta.dualApprovalRequired) {
    if (!approvalEvidence || !approvalEvidence.approver) {
      throw new ConfigAuditError(
        `Critical severity setting "${normalizedKey}" requires secondary maintainer approval (approvalEvidence.approver).`,
        'DUAL_APPROVAL_REQUIRED',
        428,
        { requiredField: 'approvalEvidence.approver' }
      );
    }

    const primaryActorId = String(actor.id || actor.sub || actor).trim().toLowerCase();
    const secondaryApproverId = String(approvalEvidence.approver).trim().toLowerCase();

    if (primaryActorId === secondaryApproverId) {
      throw new ConfigAuditError(
        'Two-person rule violation: Secondary approver cannot be the same maintainer requesting the change.',
        'SELF_APPROVAL_FORBIDDEN',
        422
      );
    }
  }

  const db = await resolveDb(injectedDb);
  const evidenceCol = db.collection(COLLECTIONS.configAuditEvidence || 'config_audit_evidence');
  const configCol = db.collection(COLLECTIONS.systemConfig || 'system_config');

  // 5. Retry / Idempotency path: check if this operationId was already executed
  const opId = String(operationId || `op_cfg_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  const existingRecord = await evidenceCol.findOne({ operationId: opId });
  if (existingRecord) {
    return {
      success: true,
      idempotentReplay: true,
      evidence: existingRecord,
      config: { [normalizedKey]: existingRecord.after },
    };
  }

  // 6. Fetch current configuration value to calculate diff
  const currentConfigDoc = await configCol.findOne({ _id: normalizedKey });
  const currentValue =
    currentConfigDoc?.value !== undefined
      ? currentConfigDoc.value
      : settingMeta.rule?.defaultValue ?? null;

  // No-op check: if the value is unchanged, reject to prevent spurious noise in the tamper-evident chain
  if (canonicalize(currentValue) === canonicalize(proposedValue)) {
    throw new ConfigAuditError(
      `No-op change: setting "${normalizedKey}" already has the value ${JSON.stringify(proposedValue)}.`,
      'NOOP_MUTATION',
      400
    );
  }

  // 7. Append to evidence chain with concurrency conflict retries (optimistic head linkage)
  let committedEvidence = null;
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [latestRecord] = await evidenceCol.find({}).sort({ sequence: -1 }).limit(1).toArray();
    const sequence = (latestRecord?.sequence ?? -1) + 1;
    const previousEvidenceHash = latestRecord?.recordHash || GENESIS_PREV_HASH;

    const evidence = buildConfigAuditEvidence({
      operationId: opId,
      sequence,
      previousEvidenceHash,
      settingKey: normalizedKey,
      category: settingMeta.category,
      changeType: CONFIG_AUDIT_CHANGE_TYPES.UPDATE,
      severity: settingMeta.severity,
      before: currentValue,
      after: proposedValue,
      actor,
      reason,
      approvalEvidence,
      signingKey,
      now,
    });

    try {
      await evidenceCol.insertOne(evidence);
      committedEvidence = evidence;
      break;
    } catch (err) {
      if (err?.code === 11000) {
        // Idempotency check if another worker just inserted the same operationId
        const duplicateOp = await evidenceCol.findOne({ operationId: opId });
        if (duplicateOp) {
          return {
            success: true,
            idempotentReplay: true,
            evidence: duplicateOp,
            config: { [normalizedKey]: duplicateOp.after },
          };
        }
        // Sequence conflict: another write won the race; retry from new head
        continue;
      }
      throw err;
    }
  }

  if (!committedEvidence) {
    throw new ConfigAuditError(
      'Could not commit configuration audit evidence due to concurrent head contention.',
      'EVIDENCE_CHAIN_CONFLICT',
      409
    );
  }

  // 8. Commit active configuration state
  const updatedDoc = {
    _id: normalizedKey,
    value: proposedValue,
    category: settingMeta.category,
    severity: settingMeta.severity,
    lastEvidenceId: committedEvidence.evidenceId,
    updatedAt: new Date(committedEvidence.createdAt),
    updatedBy: actor.id || actor.sub || actor,
  };

  await configCol.updateOne({ _id: normalizedKey }, { $set: updatedDoc }, { upsert: true });

  // 9. Optional ledger integration: append to general auditLedger for holistic traceability
  try {
    if (typeof appendAuditRecord === 'function' && db.collection(COLLECTIONS.auditLedger)) {
      await appendAuditRecord({
        db,
        operationId: `ledger_cfg_${committedEvidence.evidenceId}`,
        actor: actor.id || actor.sub || 'admin',
        action: 'config.admin_change',
        target: { type: 'system_config', key: normalizedKey },
        reason,
        before: currentValue,
        after: proposedValue,
        intent: {
          evidenceId: committedEvidence.evidenceId,
          recordHash: committedEvidence.recordHash,
          severity: settingMeta.severity,
        },
        result: { status: 'applied' },
      });
    }
  } catch {
    // Non-fatal if general ledger is unavailable in isolated unit tests
  }

  return {
    success: true,
    idempotentReplay: false,
    evidence: committedEvidence,
    config: { [normalizedKey]: proposedValue },
  };
}

/**
 * Reverts an administrative configuration change to its recorded prior state.
 *
 * Implements:
 * - Immutable history preservation: Never rewrites or deletes target evidence.
 * - Append-only rollback record with forward-linked hash chain.
 * - Dual-approval validation if target was CRITICAL.
 */
export async function rollbackConfigChange({
  db: injectedDb,
  evidenceId,
  actor,
  reason,
  approvalEvidence = null,
  signingKey = DEFAULT_AUDIT_SIGNING_KEY,
  operationId,
  now = new Date(),
}) {
  if (!actor || actor.role !== 'admin') {
    throw new ConfigAuditError(
      'Unauthorized. Administrative privileges required to rollback configuration.',
      'UNAUTHORIZED_ADMIN',
      403
    );
  }

  if (!evidenceId || typeof evidenceId !== 'string') {
    throw new ConfigAuditError('evidenceId is required for configuration rollback.', 'INVALID_EVIDENCE_ID', 400);
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
    throw new ConfigAuditError(
      'A valid justification reason (minimum 5 characters) is required for configuration rollback.',
      'MISSING_AUDIT_REASON',
      400
    );
  }

  const db = await resolveDb(injectedDb);
  const evidenceCol = db.collection(COLLECTIONS.configAuditEvidence || 'config_audit_evidence');
  const configCol = db.collection(COLLECTIONS.systemConfig || 'system_config');

  // Fetch target evidence
  const targetEvidence = await evidenceCol.findOne({ evidenceId });
  if (!targetEvidence) {
    throw new ConfigAuditError(`Target evidence "${evidenceId}" not found.`, 'EVIDENCE_NOT_FOUND', 404);
  }

  const settingKey = targetEvidence.settingKey;
  const targetPriorValue = targetEvidence.before;

  // Dual-approval enforcement if target change is CRITICAL
  if (targetEvidence.severity === CONFIG_AUDIT_SEVERITY.CRITICAL) {
    if (!approvalEvidence || !approvalEvidence.approver) {
      throw new ConfigAuditError(
        `Rollback of critical setting "${settingKey}" requires secondary maintainer approval (approvalEvidence.approver).`,
        'DUAL_APPROVAL_REQUIRED',
        428
      );
    }
    const primaryActorId = String(actor.id || actor.sub || actor).trim().toLowerCase();
    const secondaryApproverId = String(approvalEvidence.approver).trim().toLowerCase();
    if (primaryActorId === secondaryApproverId) {
      throw new ConfigAuditError(
        'Two-person rule violation: Secondary approver cannot be the same maintainer requesting the rollback.',
        'SELF_APPROVAL_FORBIDDEN',
        422
      );
    }
  }

  // Fetch current active value
  const currentDoc = await configCol.findOne({ _id: settingKey });
  const currentValue = currentDoc ? currentDoc.value : targetEvidence.after;

  // Append new ROLLBACK evidence
  const opId = operationId || `rollback_${evidenceId}_${Date.now()}`;
  let rollbackEvidence = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const [latestRecord] = await evidenceCol.find({}).sort({ sequence: -1 }).limit(1).toArray();
    const sequence = (latestRecord?.sequence ?? -1) + 1;
    const previousEvidenceHash = latestRecord?.recordHash || GENESIS_PREV_HASH;

    const evidence = buildConfigAuditEvidence({
      operationId: opId,
      sequence,
      previousEvidenceHash,
      settingKey,
      category: targetEvidence.category,
      changeType: CONFIG_AUDIT_CHANGE_TYPES.ROLLBACK,
      severity: targetEvidence.severity,
      before: currentValue,
      after: targetPriorValue,
      actor,
      reason: `Rollback of ${evidenceId}: ${reason.trim()}`,
      approvalEvidence,
      targetEvidenceId: evidenceId,
      signingKey,
      now,
    });

    try {
      await evidenceCol.insertOne(evidence);
      rollbackEvidence = evidence;
      break;
    } catch (err) {
      if (err?.code === 11000) continue;
      throw err;
    }
  }

  if (!rollbackEvidence) {
    throw new ConfigAuditError(
      'Could not commit rollback evidence due to chain contention.',
      'EVIDENCE_CHAIN_CONFLICT',
      409
    );
  }

  // Update active configuration
  await configCol.updateOne(
    { _id: settingKey },
    {
      $set: {
        _id: settingKey,
        value: targetPriorValue,
        lastEvidenceId: rollbackEvidence.evidenceId,
        updatedAt: new Date(rollbackEvidence.createdAt),
        updatedBy: actor.id || actor.sub || actor,
      },
    },
    { upsert: true }
  );

  return {
    success: true,
    rollbackEvidence,
    config: { [settingKey]: targetPriorValue },
  };
}

/**
 * Builds an exportable, privacy-preserving audit evidence bundle for compliance and investigations.
 */
export async function exportConfigAuditBundle({
  db: injectedDb,
  filter = {},
  bundleKey = DEFAULT_AUDIT_SIGNING_KEY,
  requestedBy = { id: 'admin', role: 'admin' },
}) {
  const db = await resolveDb(injectedDb);
  const evidenceCol = db.collection(COLLECTIONS.configAuditEvidence || 'config_audit_evidence');

  const query = {};
  if (filter.settingKey) query.settingKey = String(filter.settingKey);
  if (filter.category) query.category = String(filter.category);
  if (filter.actorId) query['actor.id'] = String(filter.actorId);
  if (filter.from || filter.to) {
    query.createdAt = {};
    if (filter.from) query.createdAt.$gte = new Date(filter.from).toISOString();
    if (filter.to) query.createdAt.$lte = new Date(filter.to).toISOString();
  }

  const limit = Math.min(Math.max(Number(filter.limit) || 1000, 1), 5000);
  const rawRecords = await evidenceCol.find(query).sort({ sequence: 1 }).limit(limit).toArray();

  const isUnfiltered = Object.keys(query).length === 0;
  const chainVerification = isUnfiltered
    ? verifyConfigAuditChain(rawRecords, { signingKey: bundleKey })
    : { valid: null, note: 'Filtered export; chain continuity must be verified on complete export.' };

  const rootHash = rawRecords.length > 0 ? rawRecords[rawRecords.length - 1].recordHash : GENESIS_PREV_HASH;

  return {
    schemaVersion: CONFIG_AUDIT_SCHEMA_VERSION,
    bundleType: 'administrative_configuration_audit_evidence',
    exportedAt: new Date().toISOString(),
    requestedBy: {
      id: String(requestedBy.id || 'admin'),
      role: String(requestedBy.role || 'admin'),
    },
    totalEntries: rawRecords.length,
    rootHash,
    chainVerification,
    entries: rawRecords,
  };
}
