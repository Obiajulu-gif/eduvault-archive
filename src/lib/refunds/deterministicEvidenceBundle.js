/**
 * Deterministic Refund Dispute Evidence Bundles.
 *
 * Produces byte-stable, cryptographically verifiable evidence bundles for
 * refund disputes so that identical evidence always yields the exact same
 * canonical representation, section digests, bundleDigest, and bundleId
 * regardless of JSON key ordering, access-log arrival order, or retry attempts.
 *
 * Preserves all existing contracts in `src/lib/refunds/disputeWorkflow.js`.
 */

import crypto from 'node:crypto';
import { canonicalize, normalizeNumber, normalizeString } from '../canonical.js';
import { DISPUTE_STATUS, validateEvidenceBundle } from './disputeWorkflow.js';

export const DETERMINISTIC_EVIDENCE_SCHEMA_VERSION = 'refund-dispute-evidence-v1';
export const MIN_PROVENANCE_KEY_LENGTH = 32;

const PRIVILEGED_ROLES = new Set(['admin', 'reviewer']);
const READ_ROLES = new Set(['admin', 'reviewer', 'auditor', 'support']);
const LOCKED_EVIDENCE_STATUSES = new Set([
  DISPUTE_STATUS.APPROVED,
  DISPUTE_STATUS.DENIED,
  DISPUTE_STATUS.EXECUTED,
]);

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hmacSha256Hex(key, input) {
  return crypto.createHmac('sha256', key).update(input).digest('hex');
}

function normalizeIsoTimestamp(value, fieldName) {
  if (value == null || value === '') {
    throw new Error(`invalid_timestamp:${fieldName}`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid_timestamp:${fieldName}`);
  }
  return date.toISOString();
}

function normalizeOptionalIsoTimestamp(value, fieldName) {
  if (value == null || value === '') return null;
  return normalizeIsoTimestamp(value, fieldName);
}

function normalizeOptionalString(value) {
  if (value == null) return null;
  const normalized = normalizeString(String(value));
  return normalized.length > 0 ? normalized : null;
}

function normalizeAddress(value) {
  return normalizeString(String(value || ''));
}

function compareLex(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Canonicalizes a single access log entry.
 */
function normalizeAccessLogEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`invalid_access_log_entry:${index}`);
  }

  const normalized = {
    timestamp: normalizeIsoTimestamp(entry.timestamp, `accessLogs[${index}].timestamp`),
    action: normalizeString(String(entry.action || 'unknown')).toLowerCase(),
    status: normalizeString(String(entry.status || 'unknown')).toLowerCase(),
  };

  if (entry.materialId != null) {
    normalized.materialId = normalizeString(String(entry.materialId));
  }
  if (entry.resourceId != null) {
    normalized.resourceId = normalizeString(String(entry.resourceId));
  }
  if (entry.ipHash != null) {
    normalized.ipHash = normalizeString(String(entry.ipHash));
  }
  if (entry.bytesServed != null) {
    normalized.bytesServed = normalizeNumber(entry.bytesServed);
  }

  return normalized;
}

/**
 * Canonicalizes and deterministically sorts/deduplicates an evidence bundle
 * payload while preserving all fields required by `validateEvidenceBundle`.
 */
export function canonicalizeDisputeEvidence(bundle) {
  const validation = validateEvidenceBundle(bundle);
  if (!validation.valid) {
    return {
      ok: false,
      reason: 'incomplete_evidence_bundle',
      errors: validation.errors,
    };
  }

  try {
    const buyerClaim = {
      reason: normalizeString(String(bundle.buyerClaim.reason)),
      description: normalizeOptionalString(bundle.buyerClaim.description) ?? '',
      submittedAt: normalizeIsoTimestamp(bundle.buyerClaim.submittedAt, 'buyerClaim.submittedAt'),
    };

    const creatorMetadata = {
      materialId: normalizeString(String(bundle.creatorMetadata.materialId)),
      creatorAddress: normalizeAddress(bundle.creatorMetadata.creatorAddress),
      version: normalizeString(String(bundle.creatorMetadata.version)),
      ...(bundle.creatorMetadata.title != null
        ? { title: normalizeString(String(bundle.creatorMetadata.title)) }
        : {}),
    };

    const amount = normalizeNumber(bundle.purchaseTransaction.amount);
    if (amount <= 0) {
      return {
        ok: false,
        reason: 'incomplete_evidence_bundle',
        errors: ['invalid_transaction_amount'],
      };
    }

    const purchaseTransaction = {
      transactionHash: normalizeString(String(bundle.purchaseTransaction.transactionHash)),
      amount,
      assetCode: normalizeString(String(bundle.purchaseTransaction.assetCode)).toUpperCase(),
      ...(bundle.purchaseTransaction.purchasedAt != null
        ? {
            purchasedAt: normalizeIsoTimestamp(
              bundle.purchaseTransaction.purchasedAt,
              'purchaseTransaction.purchasedAt'
            ),
          }
        : {}),
    };

    // Normalize, sort, and deduplicate access logs so arrival order never alters the digest.
    const normalizedLogs = bundle.accessLogs.map((entry, idx) =>
      normalizeAccessLogEntry(entry, idx)
    );
    const seenLogs = new Set();
    const dedupedLogs = [];
    for (const log of normalizedLogs) {
      const key = canonicalize(log);
      if (!seenLogs.has(key)) {
        seenLogs.add(key);
        dedupedLogs.push({ log, key });
      }
    }
    dedupedLogs.sort((a, b) => {
      const tsCmp = compareLex(a.log.timestamp, b.log.timestamp);
      if (tsCmp !== 0) return tsCmp;
      const actionCmp = compareLex(a.log.action, b.log.action);
      if (actionCmp !== 0) return actionCmp;
      const statusCmp = compareLex(a.log.status, b.log.status);
      if (statusCmp !== 0) return statusCmp;
      return compareLex(a.key, b.key);
    });
    const accessLogs = dedupedLogs.map((item) => item.log);

    const entitlementState = {
      active: Boolean(bundle.entitlementState.active),
      ...(bundle.entitlementState.grantedAt != null
        ? {
            grantedAt: normalizeOptionalIsoTimestamp(
              bundle.entitlementState.grantedAt,
              'entitlementState.grantedAt'
            ),
          }
        : {}),
      ...(bundle.entitlementState.revokedAt != null
        ? {
            revokedAt: normalizeOptionalIsoTimestamp(
              bundle.entitlementState.revokedAt,
              'entitlementState.revokedAt'
            ),
          }
        : {}),
    };

    return {
      ok: true,
      canonicalEvidence: {
        buyerClaim,
        creatorMetadata,
        purchaseTransaction,
        accessLogs,
        entitlementState,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_evidence_format',
      errors: [err.message || 'canonicalization_failed'],
    };
  }
}

/**
 * Builds a deterministic, verifiable refund dispute evidence bundle.
 *
 * @param {object} params
 * @param {string} params.purchaseId
 * @param {string} [params.disputeId]
 * @param {object} params.evidenceBundle
 * @param {string} [params.bundleKey] Optional >=32 char secret for HMAC provenance seal.
 */
export function buildDeterministicDisputeEvidenceBundle({
  purchaseId,
  disputeId = null,
  evidenceBundle,
  bundleKey = null,
} = {}) {
  if (!purchaseId || typeof purchaseId !== 'string' || !purchaseId.trim()) {
    return {
      ok: false,
      reason: 'missing_purchase_id',
      errors: ['purchaseId is required'],
    };
  }

  if (bundleKey != null) {
    if (typeof bundleKey !== 'string' || bundleKey.length < MIN_PROVENANCE_KEY_LENGTH) {
      return {
        ok: false,
        reason: 'invalid_bundle_key',
        errors: [`bundleKey must be at least ${MIN_PROVENANCE_KEY_LENGTH} characters`],
      };
    }
  }

  const canonicalized = canonicalizeDisputeEvidence(evidenceBundle);
  if (!canonicalized.ok) {
    return canonicalized;
  }

  const sections = canonicalized.canonicalEvidence;
  const sectionDigests = {
    buyerClaim: sha256Hex(canonicalize(sections.buyerClaim)),
    creatorMetadata: sha256Hex(canonicalize(sections.creatorMetadata)),
    purchaseTransaction: sha256Hex(canonicalize(sections.purchaseTransaction)),
    accessLogs: sha256Hex(canonicalize(sections.accessLogs)),
    entitlementState: sha256Hex(canonicalize(sections.entitlementState)),
  };

  const deterministicBody = {
    schemaVersion: DETERMINISTIC_EVIDENCE_SCHEMA_VERSION,
    purchaseId: normalizeString(purchaseId),
    ...(disputeId != null ? { disputeId: normalizeString(String(disputeId)) } : {}),
    sections,
    sectionDigests,
  };

  const canonicalBody = canonicalize(deterministicBody);
  const bundleDigest = sha256Hex(canonicalBody);
  const bundleId = `rdeb_${bundleDigest.slice(0, 24)}`;

  const provenanceSeal = bundleKey
    ? {
        algorithm: 'hmac-sha256',
        keyFingerprint: hmacSha256Hex(bundleKey, 'rdeb-key-fingerprint').slice(0, 16),
        signature: hmacSha256Hex(bundleKey, `rdeb-seal|${bundleDigest}`),
      }
    : null;

  return {
    ok: true,
    bundle: {
      bundleId,
      bundleDigest,
      schemaVersion: DETERMINISTIC_EVIDENCE_SCHEMA_VERSION,
      purchaseId: deterministicBody.purchaseId,
      ...(deterministicBody.disputeId ? { disputeId: deterministicBody.disputeId } : {}),
      sections,
      sectionDigests,
      provenanceSeal,
    },
  };
}

/**
 * Verifies a deterministic refund dispute evidence bundle's integrity.
 * Detects any field tampering, section mismatch, digest mismatch, or invalid seal.
 */
export function verifyDeterministicDisputeEvidenceBundle(bundle, { bundleKey = null } = {}) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['malformed_bundle'] };
  }

  if (bundle.schemaVersion !== DETERMINISTIC_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`unsupported_schema_version:${bundle.schemaVersion}`);
  }

  const rebuilt = buildDeterministicDisputeEvidenceBundle({
    purchaseId: bundle.purchaseId,
    disputeId: bundle.disputeId ?? null,
    evidenceBundle: bundle.sections,
    bundleKey: null,
  });

  if (!rebuilt.ok) {
    return {
      valid: false,
      errors: [...errors, ...(rebuilt.errors || [rebuilt.reason])],
    };
  }

  const expected = rebuilt.bundle;

  for (const key of Object.keys(expected.sectionDigests)) {
    if (bundle.sectionDigests?.[key] !== expected.sectionDigests[key]) {
      errors.push(`section_digest_mismatch:${key}`);
    }
  }

  if (bundle.bundleDigest !== expected.bundleDigest) {
    errors.push('bundle_digest_mismatch');
  }

  if (bundle.bundleId !== expected.bundleId) {
    errors.push('bundle_id_mismatch');
  }

  if (bundleKey != null) {
    if (typeof bundleKey !== 'string' || bundleKey.length < MIN_PROVENANCE_KEY_LENGTH) {
      errors.push('invalid_bundle_key');
    } else if (!bundle.provenanceSeal) {
      errors.push('missing_provenance_seal');
    } else {
      const expectedFp = hmacSha256Hex(bundleKey, 'rdeb-key-fingerprint').slice(0, 16);
      const expectedSig = hmacSha256Hex(bundleKey, `rdeb-seal|${expected.bundleDigest}`);
      if (bundle.provenanceSeal.keyFingerprint !== expectedFp) {
        errors.push('provenance_key_fingerprint_mismatch');
      }
      if (bundle.provenanceSeal.signature !== expectedSig) {
        errors.push('provenance_signature_mismatch');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Fail-closed authorization check for refund dispute evidence operations.
 *
 * @param {object} params
 * @param {object} params.actor - `{ id, role, address }`
 * @param {'build'|'read'|'attach'|'rollback'} params.action
 * @param {object} [params.dispute] - Dispute document (for ownership/status checks)
 */
export function authorizeDisputeEvidenceAction({ actor, action, dispute = null } = {}) {
  if (!actor || typeof actor !== 'object' || (!actor.id && !actor.address)) {
    return {
      authorized: false,
      statusCode: 401,
      reason: 'authentication_required',
    };
  }

  const role = String(actor.role || '').trim().toLowerCase();
  const actorAddr = String(actor.address || actor.id || '').trim().toLowerCase();
  const buyerAddr = String(dispute?.buyerAddress || '').trim().toLowerCase();
  const creatorAddr = String(
    dispute?.evidenceBundle?.creatorMetadata?.creatorAddress || ''
  )
    .trim()
    .toLowerCase();

  if (action === 'rollback') {
    if (role === 'admin') {
      return { authorized: true, statusCode: 200 };
    }
    return { authorized: false, statusCode: 403, reason: 'admin_role_required' };
  }

  if (action === 'read') {
    if (READ_ROLES.has(role)) return { authorized: true, statusCode: 200 };
    if (buyerAddr && actorAddr === buyerAddr) return { authorized: true, statusCode: 200 };
    if (creatorAddr && actorAddr === creatorAddr) return { authorized: true, statusCode: 200 };
    return { authorized: false, statusCode: 403, reason: 'forbidden_evidence_read' };
  }

  if (action === 'build' || action === 'attach') {
    if (PRIVILEGED_ROLES.has(role)) return { authorized: true, statusCode: 200 };
    if (buyerAddr && actorAddr === buyerAddr) {
      // Buyers may only submit/attach evidence while the dispute is in `opened` state.
      if (action === 'attach' && dispute && dispute.status !== DISPUTE_STATUS.OPENED) {
        return {
          authorized: false,
          statusCode: 403,
          reason: 'buyer_cannot_modify_after_review_started',
        };
      }
      return { authorized: true, statusCode: 200 };
    }
    return { authorized: false, statusCode: 403, reason: 'forbidden_evidence_write' };
  }

  return { authorized: false, statusCode: 403, reason: 'unknown_action' };
}

/**
 * Attaches a deterministic evidence bundle to a dispute with idempotent retry
 * semantics, conflict detection, and fail-closed authorization.
 */
export async function attachDeterministicEvidenceBundle({
  db,
  disputeId,
  evidenceBundle,
  actor,
  bundleKey = null,
  allowSupersede = false,
  now = new Date(),
}) {
  const disputesCol = db.collection('disputes');
  const dispute = await disputesCol.findOne({ _id: disputeId });

  if (!dispute) {
    return { success: false, statusCode: 404, reason: 'dispute_not_found' };
  }

  const auth = authorizeDisputeEvidenceAction({ actor, action: 'attach', dispute });
  if (!auth.authorized) {
    return { success: false, statusCode: auth.statusCode, reason: auth.reason };
  }

  if (LOCKED_EVIDENCE_STATUSES.has(dispute.status)) {
    return {
      success: false,
      statusCode: 409,
      reason: 'dispute_evidence_locked',
      currentStatus: dispute.status,
    };
  }

  const built = buildDeterministicDisputeEvidenceBundle({
    purchaseId: dispute.purchaseId,
    disputeId: String(dispute._id),
    evidenceBundle,
    bundleKey,
  });

  if (!built.ok) {
    return {
      success: false,
      statusCode: 400,
      reason: built.reason,
      errors: built.errors,
    };
  }

  const { bundle } = built;
  const existing = dispute.deterministicEvidence;

  // Idempotent retry path: identical canonical evidence produces the same digest.
  if (existing && existing.bundleDigest === bundle.bundleDigest) {
    return {
      success: true,
      idempotent: true,
      bundle,
      dispute,
    };
  }

  // Conflicting retry path: reject unless an admin/reviewer explicitly supersedes.
  if (existing && existing.bundleDigest !== bundle.bundleDigest) {
    const role = String(actor?.role || '').trim().toLowerCase();
    if (!allowSupersede || !PRIVILEGED_ROLES.has(role)) {
      return {
        success: false,
        statusCode: 409,
        reason: 'evidence_bundle_conflict',
        existingDigest: existing.bundleDigest,
        incomingDigest: bundle.bundleDigest,
      };
    }
  }

  const timestamp = now instanceof Date ? now : new Date(now);
  const currentRevision = existing?.revision ?? 0;
  const nextRevision = currentRevision + 1;

  const nextDeterministicEvidence = {
    ...bundle,
    revision: nextRevision,
    attachedAt: timestamp.toISOString(),
    attachedBy: actor.id || actor.address,
    previousSnapshot: existing
      ? {
          bundleId: existing.bundleId,
          bundleDigest: existing.bundleDigest,
          schemaVersion: existing.schemaVersion,
          sections: existing.sections,
          sectionDigests: existing.sectionDigests,
          provenanceSeal: existing.provenanceSeal ?? null,
          revision: existing.revision,
          attachedAt: existing.attachedAt,
          attachedBy: existing.attachedBy,
        }
      : null,
  };

  const query = {
    _id: dispute._id,
    status: dispute.status,
  };
  if (existing) {
    query['deterministicEvidence.revision'] = currentRevision;
  }

  const updated = await disputesCol.findOneAndUpdate(
    query,
    {
      $set: {
        evidenceBundle: bundle.sections,
        deterministicEvidence: nextDeterministicEvidence,
        updatedAt: timestamp,
      },
      $push: {
        history: {
          status: dispute.status,
          action: existing ? 'evidence_bundle_superseded' : 'evidence_bundle_attached',
          actor: actor.id || actor.address,
          timestamp,
          bundleId: bundle.bundleId,
          bundleDigest: bundle.bundleDigest,
          revision: nextRevision,
        },
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) {
    return {
      success: false,
      statusCode: 409,
      reason: 'concurrent_mutation',
    };
  }

  return {
    success: true,
    idempotent: false,
    bundle,
    dispute: updated,
  };
}

/**
 * Rolls back the latest deterministic evidence bundle attachment on a non-executed
 * dispute. Admin-only. Restores `previousSnapshot` if present, or clears
 * `deterministicEvidence` if rolling back revision 1.
 */
export async function rollbackDeterministicEvidenceBundle({
  db,
  disputeId,
  actor,
  reason = 'operator_rollback',
  now = new Date(),
}) {
  const disputesCol = db.collection('disputes');
  const dispute = await disputesCol.findOne({ _id: disputeId });

  if (!dispute) {
    return { success: false, statusCode: 404, reason: 'dispute_not_found' };
  }

  const auth = authorizeDisputeEvidenceAction({ actor, action: 'rollback', dispute });
  if (!auth.authorized) {
    return { success: false, statusCode: auth.statusCode, reason: auth.reason };
  }

  if (dispute.status === DISPUTE_STATUS.EXECUTED) {
    return {
      success: false,
      statusCode: 409,
      reason: 'cannot_rollback_executed_dispute',
    };
  }

  const current = dispute.deterministicEvidence;
  if (!current) {
    return {
      success: false,
      statusCode: 404,
      reason: 'no_deterministic_evidence_to_rollback',
    };
  }

  const timestamp = now instanceof Date ? now : new Date(now);
  const restored = current.previousSnapshot
    ? {
        ...current.previousSnapshot,
        previousSnapshot: null,
      }
    : null;

  const updated = await disputesCol.findOneAndUpdate(
    {
      _id: dispute._id,
      status: dispute.status,
    },
    {
      $set: {
        deterministicEvidence: restored,
        ...(restored ? { evidenceBundle: restored.sections } : {}),
        updatedAt: timestamp,
      },
      $push: {
        history: {
          status: dispute.status,
          action: 'evidence_bundle_rolled_back',
          actor: actor.id || actor.address,
          timestamp,
          rolledBackBundleId: current.bundleId,
          rolledBackDigest: current.bundleDigest,
          restoredBundleId: restored?.bundleId ?? null,
          reason,
        },
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) {
    return {
      success: false,
      statusCode: 409,
      reason: 'concurrent_mutation',
    };
  }

  return {
    success: true,
    rolledBackBundleId: current.bundleId,
    restoredBundleId: restored?.bundleId ?? null,
    dispute: updated,
  };
}
