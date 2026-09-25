import { ObjectId } from 'mongodb';
import { COLLECTIONS } from '@/lib/backend/schemaContracts';
import { normalizeBuyerAddress } from '@/lib/purchases/access';
import { revokeEntitlement } from '@/lib/entitlement';
import { getTransactionStatus } from '@/lib/stellar/horizonClient';
import {
  buildRefundTransaction,
  submitRefundTransaction,
  getTreasuryBalance,
} from '@/lib/stellar/refundService';
import { deriveRefundTerms } from './refundPolicy';
import { recordRefundAuditEvent } from './refundAudit';
import logger from '@/lib/logger';

/**
 * Custody-safe, idempotent refund state machine (Issue #27).
 *
 * States: requested -> approved -> submitting -> (settled | pending | failed)
 *   - requested: buyer/admin filed a claim; terms already derived & frozen.
 *   - approved: an admin authorized payment; not yet attempted on-chain.
 *   - submitting: a worker currently owns this claim and is building/signing/
 *     submitting the payment (transient — claimed via compare-and-set so only
 *     one worker/request can hold it at a time).
 *   - pending: submission outcome was ambiguous (timeout/crash); awaiting
 *     reconciliation by transaction hash before anything else happens.
 *   - settled: on-chain payment confirmed; entitlement revocation + purchase
 *     mirroring converge here (idempotently, so a crash mid-convergence is
 *     safely retried without resubmitting the payment).
 *   - failed: exhausted retries or hit a permanent block (e.g. treasury
 *     shortage); requires an explicit admin retry to move again.
 *   - rejected: terminal denial from `requested` (or `failed`).
 *
 * Every transition is a single `findOneAndUpdate` compare-and-set on
 * `{_id, status: <expected>}` — the same shape the codebase already uses for
 * atomic claims (see src/lib/backend/outbox.js), so concurrent approvals,
 * concurrent worker instances, and retries after a crash can never double-act
 * on the same refund.
 */

export const REFUND_STATUS = {
  REQUESTED: 'requested',
  APPROVED: 'approved',
  SUBMITTING: 'submitting',
  PENDING: 'pending',
  SETTLED: 'settled',
  FAILED: 'failed',
  REJECTED: 'rejected',
};

const MAX_SUBMIT_RETRIES = Number(process.env.REFUND_MAX_RETRY_ATTEMPTS || 5);
const STUCK_SUBMITTING_MS = Number(process.env.REFUND_STUCK_SUBMITTING_MS || 5 * 60 * 1000);
// A submitted transaction's own time-bounds (see buildRefundTransaction's
// setTimeout(30)) expire well before this — once we've waited this long
// without Horizon ever confirming or finding it, it's safe to treat as
// definitively unresolvable and rebuild, rather than polling forever.
const PENDING_TIMEOUT_MS = Number(process.env.REFUND_PENDING_TIMEOUT_MS || 10 * 60 * 1000);

function refundsCollection(db) {
  return db.collection(COLLECTIONS.refunds);
}

async function transition(db, refundId, fromStatuses, toStatus, extraSet = {}) {
  const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
  return refundsCollection(db).findOneAndUpdate(
    { _id: refundId, status: { $in: from } },
    { $set: { status: toStatus, updatedAt: new Date(), ...extraSet } },
    { returnDocument: 'after' }
  );
}

/**
 * File a refund claim. Terms (destination/asset/amount/network) are derived
 * once here from the trusted purchase record and frozen onto the claim —
 * approval and submission act on these frozen terms, never on caller input.
 */
export async function requestRefund({ db, purchaseId, buyerAddress, actor, reason = null, requestedAmount = null }) {
  let purchase;
  try {
    purchase = await db.collection(COLLECTIONS.purchases).findOne({ _id: new ObjectId(String(purchaseId)) });
  } catch {
    return { success: false, reason: 'invalid_purchase_id' };
  }
  if (!purchase) {
    return { success: false, reason: 'purchase_not_found' };
  }

  if (buyerAddress && normalizeBuyerAddress(purchase.buyerAddress) !== normalizeBuyerAddress(buyerAddress)) {
    return { success: false, reason: 'not_purchase_owner' };
  }

  const terms = await deriveRefundTerms({ purchase, requestedAmount });
  if (!terms.eligible) {
    return { success: false, reason: terms.reason };
  }

  const now = new Date();
  const requestedBy = actor || purchase.buyerAddress;
  const doc = {
    purchaseId: String(purchase._id),
    materialId: purchase.materialId,
    buyerAddress: purchase.buyerAddress,
    destination: terms.destination,
    assetCode: terms.assetCode,
    network: terms.network,
    amount: terms.amount,
    status: REFUND_STATUS.REQUESTED,
    requestedBy,
    requestReason: reason,
    retryCount: 0,
    txHash: null,
    sequence: null,
    ledger: null,
    failureReason: null,
    lastError: null,
    entitlementRevoked: false,
    createdAt: now,
    updatedAt: now,
  };

  let refundId;
  try {
    const result = await refundsCollection(db).insertOne(doc);
    refundId = result.insertedId;
  } catch (error) {
    if (error?.code === 11000) {
      // Duplicate/concurrent claim for the same purchase — idempotent by
      // design: return the existing live claim instead of erroring.
      const existing = await refundsCollection(db).findOne({
        purchaseId: String(purchase._id),
        status: { $ne: REFUND_STATUS.REJECTED },
      });
      if (existing) {
        return { success: true, refund: existing, alreadyExists: true };
      }
    }
    throw error;
  }

  await recordRefundAuditEvent({
    db,
    refundId,
    purchaseId: purchase._id,
    actor: requestedBy,
    action: 'requested',
    previousStatus: null,
    newStatus: REFUND_STATUS.REQUESTED,
    reason,
  });

  return { success: true, refund: { ...doc, _id: refundId }, alreadyExists: false };
}

export async function approveRefund({ db, refundId, actor, reason = null }) {
  const updated = await transition(db, refundId, [REFUND_STATUS.REQUESTED], REFUND_STATUS.APPROVED, {
    approvedBy: actor,
    approvedAt: new Date(),
  });

  if (!updated) {
    const current = await refundsCollection(db).findOne({ _id: refundId });
    if (!current) return { success: false, reason: 'refund_not_found' };
    return { success: false, reason: 'already_transitioned', refund: current };
  }

  await recordRefundAuditEvent({
    db,
    refundId: updated._id,
    purchaseId: updated.purchaseId,
    actor,
    action: 'approved',
    previousStatus: REFUND_STATUS.REQUESTED,
    newStatus: REFUND_STATUS.APPROVED,
    reason,
  });

  return { success: true, refund: updated };
}

export async function rejectRefund({ db, refundId, actor, reason = null }) {
  const updated = await transition(
    db,
    refundId,
    [REFUND_STATUS.REQUESTED, REFUND_STATUS.FAILED],
    REFUND_STATUS.REJECTED,
    { rejectedBy: actor, rejectedAt: new Date() }
  );

  if (!updated) {
    const current = await refundsCollection(db).findOne({ _id: refundId });
    if (!current) return { success: false, reason: 'refund_not_found' };
    return { success: false, reason: 'already_transitioned', refund: current };
  }

  await recordRefundAuditEvent({
    db,
    refundId: updated._id,
    purchaseId: updated.purchaseId,
    actor,
    action: 'rejected',
    previousStatus: REFUND_STATUS.REQUESTED,
    newStatus: REFUND_STATUS.REJECTED,
    reason,
  });

  return { success: true, refund: updated };
}

/** Explicit admin action to give a permanently-failed refund another attempt. */
export async function retryFailedRefund({ db, refundId, actor, reason = null }) {
  const updated = await transition(db, refundId, [REFUND_STATUS.FAILED], REFUND_STATUS.APPROVED, {
    // Reset the automatic-retry budget — a manual retry presumes the admin
    // has addressed the underlying cause (e.g. topped up treasury), so it
    // should get a full fresh set of automatic attempts, not immediately
    // re-fail on the next hiccup because the counter was already maxed out.
    retryCount: 0,
    retryRequestedBy: actor,
  });

  if (!updated) {
    return { success: false, reason: 'not_in_failed_state' };
  }

  await recordRefundAuditEvent({
    db,
    refundId: updated._id,
    purchaseId: updated.purchaseId,
    actor,
    action: 'retry_requested',
    previousStatus: REFUND_STATUS.FAILED,
    newStatus: REFUND_STATUS.APPROVED,
    reason,
  });

  return { success: true, refund: updated };
}

async function retryOrFail(db, refund, failureReason, detail, actor, fromStatuses = [REFUND_STATUS.SUBMITTING, REFUND_STATUS.PENDING]) {
  const nextRetryCount = (refund.retryCount || 0) + 1;

  if (nextRetryCount > MAX_SUBMIT_RETRIES) {
    const failed = await transition(db, refund._id, fromStatuses, REFUND_STATUS.FAILED, {
      failureReason,
      lastError: detail,
      retryCount: nextRetryCount,
    });
    await recordRefundAuditEvent({
      db,
      refundId: refund._id,
      purchaseId: refund.purchaseId,
      actor,
      action: 'failed',
      previousStatus: refund.status,
      newStatus: REFUND_STATUS.FAILED,
      reason: failureReason,
    });
    return { outcome: 'failed', refund: failed };
  }

  const approved = await transition(db, refund._id, fromStatuses, REFUND_STATUS.APPROVED, {
    txHash: null,
    sequence: null,
    lastError: detail,
    retryCount: nextRetryCount,
  });
  await recordRefundAuditEvent({
    db,
    refundId: refund._id,
    purchaseId: refund.purchaseId,
    actor,
    action: 'retry_scheduled',
    previousStatus: refund.status,
    newStatus: REFUND_STATUS.APPROVED,
    reason: failureReason,
  });
  return { outcome: 'retry_scheduled', refund: approved };
}

/**
 * Worker step: claim one `approved` refund and attempt on-chain submission.
 * Safe to call concurrently from multiple worker instances — only one call
 * will win the compare-and-set claim per refund.
 */
export async function processApprovedRefund({
  db,
  refund,
  actor = 'system',
  buildTransaction = buildRefundTransaction,
  submitTransactionFn = submitRefundTransaction,
  getTreasuryBalanceFn = getTreasuryBalance,
  revokeEntitlementFn = revokeEntitlement,
} = {}) {
  const claimed = await transition(db, refund._id, [REFUND_STATUS.APPROVED], REFUND_STATUS.SUBMITTING, {
    submissionAttemptedAt: new Date(),
  });
  if (!claimed) {
    return { outcome: 'already_claimed' };
  }

  await recordRefundAuditEvent({
    db,
    refundId: claimed._id,
    purchaseId: claimed.purchaseId,
    actor,
    action: 'submitting',
    previousStatus: REFUND_STATUS.APPROVED,
    newStatus: REFUND_STATUS.SUBMITTING,
  });

  let treasuryBalance;
  try {
    treasuryBalance = await getTreasuryBalanceFn(claimed.assetCode);
  } catch (error) {
    logger.warn({ refundId: String(claimed._id), err: error.message }, 'refund treasury balance check failed');
    return retryOrFail(db, claimed, 'treasury_check_failed', error.message, actor, [REFUND_STATUS.SUBMITTING]);
  }
  if (treasuryBalance < claimed.amount) {
    return retryOrFail(
      db,
      claimed,
      'treasury_shortage',
      `signer balance ${treasuryBalance} < required ${claimed.amount}`,
      actor,
      [REFUND_STATUS.SUBMITTING]
    );
  }

  let built;
  try {
    built = await buildTransaction({
      destination: claimed.destination,
      amount: claimed.amount,
      assetCode: claimed.assetCode,
    });
  } catch (error) {
    // Nothing was submitted (e.g. signer/Horizon outage while loading the
    // account) — safe to return to `approved` for a fresh attempt.
    logger.warn({ refundId: String(claimed._id), err: error.message }, 'refund transaction build failed');
    return retryOrFail(db, claimed, 'build_failed', error.message, actor, [REFUND_STATUS.SUBMITTING]);
  }

  // Durability checkpoint — persisted BEFORE submission so a crash or
  // Horizon timeout after acceptance can be reconciled by hash rather than
  // resubmitted blindly.
  await refundsCollection(db).updateOne(
    { _id: claimed._id },
    { $set: { txHash: built.hash, sequence: built.sequence, updatedAt: new Date() } }
  );

  const submission = await submitTransactionFn(built.transaction, claimed.amount);

  if (submission.outcome === 'confirmed') {
    return finalizeSettlement({ db, refundId: claimed._id, txHash: submission.hash, ledger: submission.ledger, actor, revokeEntitlementFn });
  }

  if (submission.outcome === 'ambiguous') {
    const pending = await transition(db, claimed._id, [REFUND_STATUS.SUBMITTING], REFUND_STATUS.PENDING, {
      lastError: submission.reason,
      pendingSince: new Date(),
    });
    await recordRefundAuditEvent({
      db,
      refundId: claimed._id,
      purchaseId: claimed.purchaseId,
      actor,
      action: 'submission_ambiguous',
      previousStatus: REFUND_STATUS.SUBMITTING,
      newStatus: REFUND_STATUS.PENDING,
      reason: submission.reason,
    });
    return { outcome: 'pending', refund: pending };
  }

  // 'rejected' (definitive, this exact envelope never landed) or 'blocked'
  // (never left the process — signer disabled/over cap) — both are safe to
  // retry without touching the ledger.
  return retryOrFail(db, claimed, submission.reason, submission.reason, actor, [REFUND_STATUS.SUBMITTING]);
}

/**
 * Finalize a confirmed on-chain refund. Idempotent: safe to call again after
 * a crash between marking `settled` and completing entitlement revocation /
 * purchase mirroring — those side effects only run once, gated by the
 * `entitlementRevoked` flag, and access is never revoked before this point.
 */
export async function finalizeSettlement({
  db,
  refundId,
  txHash,
  ledger = null,
  operationIndex = 0,
  actor = 'system',
  revokeEntitlementFn = revokeEntitlement,
}) {
  let current = await refundsCollection(db).findOne({ _id: refundId });
  if (!current) return { outcome: 'not_found' };

  if (current.status !== REFUND_STATUS.SETTLED) {
    const settled = await transition(db, refundId, [REFUND_STATUS.SUBMITTING, REFUND_STATUS.PENDING], REFUND_STATUS.SETTLED, {
      txHash,
      ledger,
      operationIndex,
      settledAt: new Date(),
    });
    if (settled) {
      current = settled;
      await recordRefundAuditEvent({
        db,
        refundId,
        purchaseId: current.purchaseId,
        actor,
        action: 'settled',
        previousStatus: REFUND_STATUS.SUBMITTING,
        newStatus: REFUND_STATUS.SETTLED,
      });
    } else {
      current = await refundsCollection(db).findOne({ _id: refundId });
      if (!current || current.status !== REFUND_STATUS.SETTLED) {
        return { outcome: 'not_settled', refund: current };
      }
    }
  }

  if (!current.entitlementRevoked) {
    await revokeEntitlementFn(current.materialId, current.buyerAddress);
    await db.collection(COLLECTIONS.purchases).updateOne(
      { _id: new ObjectId(current.purchaseId) },
      {
        $set: {
          settlementState: 'Refunded',
          refundedAt: new Date(),
          refundTransactionHash: current.txHash,
          updatedAt: new Date(),
        },
        $inc: { refundedAmount: current.amount },
      }
    );
    await refundsCollection(db).updateOne(
      { _id: refundId },
      { $set: { entitlementRevoked: true, convergedAt: new Date() } }
    );
    await recordRefundAuditEvent({
      db,
      refundId,
      purchaseId: current.purchaseId,
      actor,
      action: 'entitlement_revoked',
      previousStatus: REFUND_STATUS.SETTLED,
      newStatus: REFUND_STATUS.SETTLED,
    });
    current = { ...current, entitlementRevoked: true };
  }

  return { outcome: 'settled', refund: current };
}

/**
 * Reconciliation entry point for anything `getRefundsAwaitingReconciliation`
 * returns: pending submissions, stale (crashed mid-flight) submissions, and
 * settled-but-not-yet-converged refunds.
 */
export async function reconcileRefund({
  db,
  refund,
  actor = 'system',
  getTransactionStatusFn = getTransactionStatus,
  revokeEntitlementFn = revokeEntitlement,
}) {
  if (refund.status === REFUND_STATUS.SETTLED) {
    return finalizeSettlement({ db, refundId: refund._id, txHash: refund.txHash, ledger: refund.ledger, actor, revokeEntitlementFn });
  }

  if (!refund.txHash) {
    // Crashed before the pre-submission durability checkpoint — nothing was
    // ever sent to Horizon, so a plain retry is safe.
    return retryOrFail(db, refund, 'no_txhash_recorded', 'no submission checkpoint found', actor, [
      REFUND_STATUS.SUBMITTING,
      REFUND_STATUS.PENDING,
    ]);
  }

  const status = await getTransactionStatusFn(refund.txHash);

  if (status === 'confirmed') {
    return finalizeSettlement({ db, refundId: refund._id, txHash: refund.txHash, actor, revokeEntitlementFn });
  }

  if (status === 'failed') {
    return retryOrFail(db, refund, 'ledger_rejected', 'transaction present but unsuccessful on ledger', actor, [
      REFUND_STATUS.SUBMITTING,
      REFUND_STATUS.PENDING,
    ]);
  }

  // 'pending' | 'not_found' — still ambiguous. A submitted transaction's own
  // time-bounds expire long before PENDING_TIMEOUT_MS, so once we've waited
  // that long without Horizon ever confirming or finding it, treat it as
  // definitively unresolvable and rebuild rather than polling forever.
  const pendingSince = refund.pendingSince ? new Date(refund.pendingSince).getTime() : null;
  if (pendingSince && Date.now() - pendingSince > PENDING_TIMEOUT_MS) {
    return retryOrFail(db, refund, 'pending_timeout_exceeded', 'transaction never resolved on the ledger', actor, [
      REFUND_STATUS.SUBMITTING,
      REFUND_STATUS.PENDING,
    ]);
  }

  const updated = await transition(db, refund._id, [REFUND_STATUS.SUBMITTING, REFUND_STATUS.PENDING], REFUND_STATUS.PENDING, {
    pendingSince: refund.pendingSince || new Date(),
  });
  return { outcome: 'still_pending', refund: updated || refund };
}

export async function getRefundsAwaitingSubmission(db, limit = 10) {
  return refundsCollection(db)
    .find({ status: REFUND_STATUS.APPROVED })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();
}

export async function getRefundsAwaitingReconciliation(db, limit = 20) {
  const staleSubmittingCutoff = new Date(Date.now() - STUCK_SUBMITTING_MS);
  return refundsCollection(db)
    .find({
      $or: [
        { status: REFUND_STATUS.PENDING },
        { status: REFUND_STATUS.SUBMITTING, updatedAt: { $lt: staleSubmittingCutoff } },
        { status: REFUND_STATUS.SETTLED, entitlementRevoked: { $ne: true } },
      ],
    })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();
}
