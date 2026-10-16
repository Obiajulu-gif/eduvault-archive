/**
 * Tamper-Evident Chronological Ledger for Privileged & Financial Events (#958)
 *
 * Implements a verifiable, append-only, cryptographic hash-chained ledger
 * covering all high-risk financial events (payouts, refunds, purchases, fee distributions)
 * and privileged administrative events (roles, suspensions, verifications, moderation).
 *
 * Features:
 * - SHA-256 hash chaining with deterministic canonicalization
 * - Monotonically increasing sequence & strict chronological order enforcement
 * - Deep tamper detection (content mutation, sequence deletion, reordering, timestamp inversion)
 * - Standardized export with cryptographic integrity receipts
 */

import crypto from 'node:crypto';
import { COLLECTIONS } from './schemaContracts.js';

export const LEDGER_VERSION = 'v2';
export const GENESIS_HASH = '0'.repeat(64);

export const EVENT_DOMAINS = {
  FINANCIAL: 'financial',
  PRIVILEGED: 'privileged',
};

export const FINANCIAL_EVENT_TYPES = {
  PAYOUT_INITIATED: 'payout_initiated',
  PAYOUT_SETTLED: 'payout_settled',
  PAYOUT_FAILED: 'payout_failed',
  REFUND_APPROVED: 'refund_approved',
  REFUND_EXECUTED: 'refund_executed',
  REFUND_REJECTED: 'refund_rejected',
  PURCHASE_SETTLEMENT: 'purchase_settlement',
  ESCROW_DEPOSIT: 'escrow_deposit',
  FEE_DISTRIBUTION: 'fee_distribution',
  SCHOLARSHIP_GRANT: 'scholarship_grant',
  SCHOLARSHIP_REDEMPTION: 'scholarship_redemption',
};

export const PRIVILEGED_EVENT_TYPES = {
  ROLE_CHANGE: 'role_change',
  PERMISSION_GRANT: 'permission_grant',
  PERMISSION_REVOKE: 'permission_revoke',
  USER_SUSPENDED: 'user_suspended',
  USER_REACTIVATED: 'user_reactivated',
  CONTENT_TAKEDOWN: 'content_takedown',
  CONTENT_QUARANTINE: 'content_quarantine',
  VERIFICATION_APPROVED: 'verification_approved',
  VERIFICATION_REJECTED: 'verification_rejected',
  KEY_ROTATION: 'key_rotation',
  ADMIN_TRANSFER: 'admin_transfer',
};

/**
 * Deterministically sorts and normalizes nested objects for canonical hashing.
 */
export function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])])
    );
  }
  return value;
}

export function canonicalize(value) {
  return JSON.stringify(normalize(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

/**
 * Computes deterministic actor proof from credentials and context.
 */
function createActorProof(actor, actorContext = {}) {
  return digest({ actor: String(actor || 'system'), ...normalize(actorContext) });
}

/**
 * Append a financial event to the tamper-evident ledger.
 */
export async function appendFinancialEvent(db, {
  operationId,
  eventType,
  actor,
  actorContext,
  financialDetails,
  target,
  intent = {},
  beforeState = null,
  afterState = null,
  result = { status: 'completed' },
  reason = null,
  timestamp = new Date(),
}) {
  if (!financialDetails || typeof financialDetails !== 'object') {
    throw new Error('Financial events require financialDetails (amount, asset, etc.)');
  }

  return appendLedgerRecord(db, {
    eventDomain: EVENT_DOMAINS.FINANCIAL,
    eventType,
    operationId,
    actor,
    actorContext,
    financialDetails: normalize(financialDetails),
    target,
    intent,
    beforeState,
    afterState,
    result,
    reason,
    timestamp,
  });
}

/**
 * Append a privileged administrative event to the tamper-evident ledger.
 */
export async function appendPrivilegedEvent(db, {
  operationId,
  eventType,
  actor,
  actorContext,
  target,
  intent = {},
  beforeState = null,
  afterState = null,
  result = { status: 'applied' },
  reason = null,
  timestamp = new Date(),
}) {
  return appendLedgerRecord(db, {
    eventDomain: EVENT_DOMAINS.PRIVILEGED,
    eventType,
    operationId,
    actor,
    actorContext,
    financialDetails: null,
    target,
    intent,
    beforeState,
    afterState,
    result,
    reason,
    timestamp,
  });
}

/**
 * Core append operation enforcing hash-chain continuity and chronological ordering.
 */
export async function appendLedgerRecord(db, {
  eventDomain,
  eventType,
  operationId,
  actor,
  actorContext,
  financialDetails = null,
  target,
  intent = {},
  beforeState = null,
  afterState = null,
  result = {},
  reason = null,
  timestamp = new Date(),
}) {
  if (!operationId || !eventType || !target) {
    throw new Error('operationId, eventType, and target are required');
  }

  const collection = db.collection(COLLECTIONS.auditLedger || 'audit_ledger');

  // Idempotency check: if operation ID exists, return existing record
  const existing = await collection.findOne({ operationId: String(operationId) });
  if (existing) return existing;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [lastRecord] = await collection.find({}).sort({ sequence: -1 }).limit(1).toArray();
    const sequence = (lastRecord?.sequence ?? -1) + 1;
    const previousHash = lastRecord?.recordHash || GENESIS_HASH;

    // Enforce chronological timestamp ordering
    const recordTimestamp = new Date(timestamp);
    if (lastRecord && recordTimestamp < new Date(lastRecord.timestamp)) {
      throw new Error(`Chronological inversion: timestamp ${recordTimestamp.toISOString()} is older than previous entry ${new Date(lastRecord.timestamp).toISOString()}`);
    }

    const content = {
      version: LEDGER_VERSION,
      sequence,
      previousHash,
      eventDomain,
      eventType: String(eventType),
      operationId: String(operationId),
      actor: String(actor || 'system'),
      actorProof: createActorProof(actor, actorContext),
      target: normalize(target),
      financialDetails: financialDetails ? normalize(financialDetails) : null,
      intentHash: digest(intent),
      beforeState: normalize(beforeState),
      afterState: normalize(afterState),
      result: normalize(result),
      reason: reason ? String(reason).slice(0, 1000) : null,
      timestamp: recordTimestamp,
    };

    const recordHash = digest(content);
    const finalRecord = { ...content, recordHash };

    try {
      await collection.insertOne(finalRecord);
      return finalRecord;
    } catch (err) {
      if (err?.code === 11000) {
        // Duplicate key check - if duplicate operationId return it
        const dup = await collection.findOne({ operationId: String(operationId) });
        if (dup) return dup;
        // Competing sequence collision, retry from new chain head
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to append ledger record due to high concurrency sequence conflicts');
}

/**
 * Deep cryptographic verification of a sequence of ledger records.
 * Detects:
 * - Content mutation
 * - Chain breakages
 * - Deleted records (sequence gaps)
 * - Reordered records
 * - Timestamp chronological inversions
 *
 * @param {Array<object>} records
 * @returns {{ valid: boolean, totalRecords: number, anomaly: object|null }}
 */
export function verifyLedgerIntegrity(records = []) {
  if (!Array.isArray(records) || records.length === 0) {
    return { valid: true, totalRecords: 0, anomaly: null };
  }

  let previousHash = GENESIS_HASH;
  let previousTimestamp = new Date(0);

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const { recordHash, _id, ...content } = record;

    // 1. Sequence Gap or Reordering Detection
    if (content.sequence !== i) {
      return {
        valid: false,
        totalRecords: records.length,
        anomaly: {
          type: 'SEQUENCE_GAP',
          sequence: content.sequence,
          expectedSequence: i,
          reason: `Record at index ${i} has sequence ${content.sequence}, expected ${i}`,
        },
      };
    }

    // 2. Hash Chain Continuity Check
    if (content.previousHash !== previousHash) {
      return {
        valid: false,
        totalRecords: records.length,
        anomaly: {
          type: 'BROKEN_CHAIN',
          sequence: content.sequence,
          expectedPreviousHash: previousHash,
          foundPreviousHash: content.previousHash,
          reason: `Chain broken at sequence ${content.sequence}. Expected previousHash ${previousHash}, found ${content.previousHash}`,
        },
      };
    }

    // 3. Content Tamper Detection
    const computedHash = digest(content);
    if (computedHash !== recordHash) {
      return {
        valid: false,
        totalRecords: records.length,
        anomaly: {
          type: 'CONTENT_MODIFICATION',
          sequence: content.sequence,
          expectedRecordHash: computedHash,
          foundRecordHash: recordHash,
          reason: `Tamper detected at sequence ${content.sequence}. Content does not match hash.`,
        },
      };
    }

    // 4. Chronological Inversion Check
    const currentTimestamp = new Date(content.timestamp);
    if (currentTimestamp < previousTimestamp) {
      return {
        valid: false,
        totalRecords: records.length,
        anomaly: {
          type: 'CHRONOLOGICAL_INVERSION',
          sequence: content.sequence,
          previousTimestamp: previousTimestamp.toISOString(),
          currentTimestamp: currentTimestamp.toISOString(),
          reason: `Timestamp inversion at sequence ${content.sequence}: ${currentTimestamp.toISOString()} is older than preceding ${previousTimestamp.toISOString()}`,
        },
      };
    }

    previousHash = recordHash;
    previousTimestamp = currentTimestamp;
  }

  return {
    valid: true,
    totalRecords: records.length,
    headHash: previousHash,
    anomaly: null,
  };
}

/**
 * Export ledger records with a cryptographically verifiable summary receipt.
 *
 * @param {import('mongodb').Db} db
 * @param {object} [options]
 * @param {string} [options.eventDomain] - 'financial' | 'privileged' | null
 * @param {string} [options.eventType]
 * @param {string} [options.format='json'] - 'json' | 'csv'
 * @param {Date|string} [options.from]
 * @param {Date|string} [options.to]
 * @param {number} [options.limit=1000]
 */
export async function exportLedger(db, options = {}) {
  const collection = db.collection(COLLECTIONS.auditLedger || 'audit_ledger');
  const query = {};

  if (options.eventDomain) {
    query.eventDomain = options.eventDomain;
  }
  if (options.eventType) {
    query.eventType = options.eventType;
  }
  if (options.from || options.to) {
    query.timestamp = {};
    if (options.from) query.timestamp.$gte = new Date(options.from);
    if (options.to) query.timestamp.$lte = new Date(options.to);
  }

  const limit = Math.min(Math.max(1, Number(options.limit) || 1000), 5000);
  const records = await collection.find(query).sort({ sequence: 1 }).limit(limit).toArray();

  // If exporting all records from sequence 0 onwards without filters, verify complete chain
  const isFullChain = Object.keys(query).length === 0 && records[0]?.sequence === 0;
  const verification = isFullChain ? verifyLedgerIntegrity(records) : null;

  const receipt = {
    exportedAt: new Date().toISOString(),
    recordCount: records.length,
    firstSequence: records[0]?.sequence ?? null,
    lastSequence: records[records.length - 1]?.sequence ?? null,
    firstHash: records[0]?.recordHash ?? null,
    lastHash: records[records.length - 1]?.recordHash ?? null,
    isCompleteChainVerified: verification ? verification.valid : false,
    exportChecksum: digest(records.map((r) => r.recordHash)),
  };

  if (options.format === 'csv') {
    const headers = [
      'sequence',
      'timestamp',
      'eventDomain',
      'eventType',
      'operationId',
      'actor',
      'targetType',
      'targetId',
      'amount',
      'asset',
      'previousHash',
      'recordHash',
    ];

    const rows = records.map((r) => [
      r.sequence,
      r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
      r.eventDomain || 'generic',
      r.eventType,
      r.operationId,
      r.actor,
      r.target?.type || '',
      r.target?.id || '',
      r.financialDetails?.amount || '',
      r.financialDetails?.asset || '',
      r.previousHash,
      r.recordHash,
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')),
    ].join('\n');

    return {
      format: 'csv',
      data: csvContent,
      receipt,
    };
  }

  return {
    format: 'json',
    records,
    receipt,
  };
}
