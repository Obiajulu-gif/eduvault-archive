import crypto from 'node:crypto';
import { COLLECTIONS } from '@/lib/backend/schemaContracts';
import { auditLog } from '@/lib/api/audit';
import { REFUND_POLICY_VERSION } from './refundPolicy';
import { appendAuditRecord } from '@/lib/backend/auditLedger';

/**
 * Tamper-evident audit trail for refund actions (Issue #27 — "every
 * privileged action emits a tamper-evident audit record with actor, reason,
 * policy version, and correlation ID").
 *
 * Each refund gets its own hash chain: every entry's `entryHash` covers the
 * previous entry's hash plus its own content, so altering or deleting a past
 * entry breaks the chain for everything recorded after it. This runs
 * alongside the existing console `auditLog()` (unchanged elsewhere in the
 * codebase) rather than replacing it — this collection is the durable,
 * verifiable record; the console log remains the existing operational
 * tailing/alerting mechanism.
 */

const GENESIS_HASH = '0'.repeat(64);

function canonicalize(entry) {
  return JSON.stringify(entry, Object.keys(entry).sort());
}

/**
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {string} params.refundId
 * @param {string} [params.purchaseId]
 * @param {string} params.actor - wallet address, admin id, or 'system' (worker)
 * @param {string} params.action - e.g. 'requested' | 'approved' | 'rejected' | 'submitted' | 'settled' | 'failed'
 * @param {string|null} [params.previousStatus]
 * @param {string|null} [params.newStatus]
 * @param {string|null} [params.reason]
 * @param {string} [params.correlationId]
 * @returns {Promise<string>} the correlationId used for this event
 */
export async function recordRefundAuditEvent({
  db,
  refundId,
  purchaseId = null,
  actor,
  action,
  previousStatus = null,
  newStatus = null,
  reason = null,
  correlationId,
}) {
  const collection = db.collection(COLLECTIONS.refundAuditLog);

  const [last] = await collection
    .find({ refundId: String(refundId) })
    .sort({ seq: -1 })
    .limit(1)
    .toArray();

  const seq = (last?.seq ?? -1) + 1;
  const prevHash = last?.entryHash ?? GENESIS_HASH;
  const resolvedCorrelationId = correlationId || crypto.randomUUID();

  const entry = {
    refundId: String(refundId),
    purchaseId: purchaseId ? String(purchaseId) : null,
    actor: actor || 'system',
    action,
    previousStatus,
    newStatus,
    reason,
    policyVersion: REFUND_POLICY_VERSION,
    correlationId: resolvedCorrelationId,
    seq,
    prevHash,
    createdAt: new Date(),
  };

  const entryHash = crypto.createHash('sha256').update(prevHash + canonicalize(entry)).digest('hex');
  await collection.insertOne({ ...entry, entryHash });

  if (db.collection('audit_ledger')) {
    await appendAuditRecord({
      db,
      operationId: `${String(refundId)}:${action}:${resolvedCorrelationId}`,
      actor: entry.actor,
      action: `refund.${action}`,
      target: { type: 'refund', id: String(refundId) },
      intent: { purchaseId: entry.purchaseId, previousStatus, newStatus, reason },
      result: { status: newStatus, correlationId: resolvedCorrelationId },
      reason,
    });
  }

  auditLog({
    event: `refund_${action}`,
    refundId: String(refundId),
    purchaseId: entry.purchaseId,
    actor: entry.actor,
    status: newStatus || undefined,
    reason: reason || undefined,
    correlationId: resolvedCorrelationId,
    policyVersion: REFUND_POLICY_VERSION,
  });

  return resolvedCorrelationId;
}

/**
 * Verify a refund's audit chain is intact — every entry's hash matches what
 * would be recomputed from its content and the previous entry's hash.
 *
 * @param {import('mongodb').Db} db
 * @param {string} refundId
 * @returns {Promise<{ valid: boolean, brokenAtSeq: number|null }>}
 */
export async function verifyRefundAuditChain(db, refundId) {
  const entries = await db
    .collection(COLLECTIONS.refundAuditLog)
    .find({ refundId: String(refundId) })
    .sort({ seq: 1 })
    .toArray();

  let expectedPrevHash = GENESIS_HASH;
  for (const entry of entries) {
    const { entryHash, _id, ...rest } = entry;
    if (rest.prevHash !== expectedPrevHash) {
      return { valid: false, brokenAtSeq: rest.seq };
    }
    const recomputed = crypto.createHash('sha256').update(rest.prevHash + canonicalize(rest)).digest('hex');
    if (recomputed !== entryHash) {
      return { valid: false, brokenAtSeq: rest.seq };
    }
    expectedPrevHash = entryHash;
  }

  return { valid: true, brokenAtSeq: null };
}
