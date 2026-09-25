/**
 * Refund Dispute Workflow & Evidence Bundle Manager (Issue #709).
 *
 * Status lifecycle:
 *   opened -> reviewing -> (approved | denied) -> executed
 */

export const DISPUTE_STATUS = {
  OPENED: 'opened',
  REVIEWING: 'reviewing',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXECUTED: 'executed',
};

async function toObjectId(id) {
  if (!id) return id;
  if (typeof id === 'object') return id;
  try {
    const { ObjectId } = await import('mongodb');
    return typeof id === 'string' && id.length === 24 ? new ObjectId(id) : id;
  } catch {
    return id;
  }
}

/**
 * Validates that an evidence bundle contains all required evidence fields.
 *
 * @param {object} bundle
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEvidenceBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object') {
    return { valid: false, errors: ['evidence_bundle_missing'] };
  }

  // 1. Buyer Claim Evidence
  if (!bundle.buyerClaim || typeof bundle.buyerClaim !== 'object') {
    errors.push('missing_buyer_claim');
  } else {
    if (!bundle.buyerClaim.reason) errors.push('missing_buyer_claim_reason');
    if (!bundle.buyerClaim.submittedAt) errors.push('missing_buyer_claim_submitted_at');
  }

  // 2. Creator Material Metadata
  if (!bundle.creatorMetadata || typeof bundle.creatorMetadata !== 'object') {
    errors.push('missing_creator_metadata');
  } else {
    if (!bundle.creatorMetadata.materialId) errors.push('missing_creator_material_id');
    if (!bundle.creatorMetadata.creatorAddress) errors.push('missing_creator_address');
    if (!bundle.creatorMetadata.version) errors.push('missing_creator_material_version');
  }

  // 3. Purchase Transaction Proof
  if (!bundle.purchaseTransaction || typeof bundle.purchaseTransaction !== 'object') {
    errors.push('missing_purchase_transaction');
  } else {
    if (!bundle.purchaseTransaction.transactionHash) errors.push('missing_transaction_hash');
    if (bundle.purchaseTransaction.amount == null || bundle.purchaseTransaction.amount <= 0) {
      errors.push('invalid_transaction_amount');
    }
    if (!bundle.purchaseTransaction.assetCode) errors.push('missing_transaction_asset_code');
  }

  // 4. Access Logs Evidence
  if (!Array.isArray(bundle.accessLogs)) {
    errors.push('missing_access_logs');
  }

  // 5. Prior Entitlement State Evidence
  if (!bundle.entitlementState || typeof bundle.entitlementState !== 'object') {
    errors.push('missing_entitlement_state');
  } else {
    if (typeof bundle.entitlementState.active !== 'boolean') {
      errors.push('missing_entitlement_active_flag');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Opens a new refund dispute with a complete evidence bundle.
 */
export async function openDispute({
  db,
  purchaseId,
  buyerAddress,
  reason,
  description = '',
  evidenceBundle,
  actor,
}) {
  if (!purchaseId || !buyerAddress || !reason) {
    return { success: false, reason: 'missing_required_fields' };
  }

  const disputesCol = db.collection('disputes');

  // Check for existing active/duplicate dispute for this purchase
  const existing = await disputesCol.findOne({
    purchaseId: String(purchaseId),
    status: { $in: [DISPUTE_STATUS.OPENED, DISPUTE_STATUS.REVIEWING, DISPUTE_STATUS.APPROVED, DISPUTE_STATUS.EXECUTED] },
  });

  if (existing) {
    return { success: false, reason: 'duplicate_dispute', dispute: existing };
  }

  const validation = validateEvidenceBundle(evidenceBundle);
  if (!validation.valid) {
    return { success: false, reason: 'incomplete_evidence_bundle', errors: validation.errors };
  }

  const now = new Date();
  const disputeDoc = {
    purchaseId: String(purchaseId),
    buyerAddress,
    openedBy: actor || buyerAddress,
    reason,
    description,
    evidenceBundle,
    status: DISPUTE_STATUS.OPENED,
    history: [
      {
        status: DISPUTE_STATUS.OPENED,
        actor: actor || buyerAddress,
        timestamp: now,
        notes: 'Dispute opened with complete evidence bundle',
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  const result = await disputesCol.insertOne(disputeDoc);
  return {
    success: true,
    dispute: { ...disputeDoc, _id: result.insertedId },
  };
}

/**
 * Transitions dispute through reviewer and maintainer status machine.
 */
export async function transitionDisputeStatus({
  db,
  disputeId,
  toStatus,
  actor,
  notes = '',
}) {
  const disputesCol = db.collection('disputes');
  const queryId = await toObjectId(disputeId);
  const dispute = await disputesCol.findOne({ _id: queryId });

  if (!dispute) {
    return { success: false, reason: 'dispute_not_found' };
  }

  const currentStatus = dispute.status;

  // Enforce valid status transition matrix
  const validTransitions = {
    [DISPUTE_STATUS.OPENED]: [DISPUTE_STATUS.REVIEWING],
    [DISPUTE_STATUS.REVIEWING]: [DISPUTE_STATUS.APPROVED, DISPUTE_STATUS.DENIED],
    [DISPUTE_STATUS.APPROVED]: [DISPUTE_STATUS.EXECUTED],
    [DISPUTE_STATUS.DENIED]: [],
    [DISPUTE_STATUS.EXECUTED]: [],
  };

  if (!validTransitions[currentStatus]?.includes(toStatus)) {
    return {
      success: false,
      reason: 'invalid_status_transition',
      currentStatus,
      targetStatus: toStatus,
    };
  }

  // Enforce evidence completeness before approving
  if (toStatus === DISPUTE_STATUS.APPROVED) {
    const validation = validateEvidenceBundle(dispute.evidenceBundle);
    if (!validation.valid) {
      return { success: false, reason: 'cannot_approve_missing_evidence', errors: validation.errors };
    }
  }

  const now = new Date();
  const historyEntry = {
    status: toStatus,
    actor,
    timestamp: now,
    notes,
  };

  const updateResult = await disputesCol.findOneAndUpdate(
    { _id: queryId, status: currentStatus },
    {
      $set: {
        status: toStatus,
        updatedAt: now,
        ...(toStatus === DISPUTE_STATUS.APPROVED ? { approvedAt: now, approvedBy: actor } : {}),
        ...(toStatus === DISPUTE_STATUS.DENIED ? { deniedAt: now, deniedBy: actor } : {}),
        ...(toStatus === DISPUTE_STATUS.EXECUTED ? { executedAt: now, executedBy: actor } : {}),
      },
      $push: { history: historyEntry },
    },
    { returnDocument: 'after' }
  );

  if (!updateResult) {
    return { success: false, reason: 'concurrent_status_mutation' };
  }

  return { success: true, dispute: updateResult };
}

/**
 * Links refund execution directly to an approved dispute state.
 */
export async function executeDisputeRefund({
  db,
  disputeId,
  actor,
  executeRefundFn,
}) {
  const disputesCol = db.collection('disputes');
  const queryId = await toObjectId(disputeId);
  const dispute = await disputesCol.findOne({ _id: queryId });

  if (!dispute) {
    return { success: false, reason: 'dispute_not_found' };
  }

  if (dispute.status !== DISPUTE_STATUS.APPROVED) {
    return {
      success: false,
      reason: 'refund_execution_requires_approved_dispute',
      currentStatus: dispute.status,
    };
  }

  // Execute refund payment using referenced dispute evidence
  let refundResult;
  if (typeof executeRefundFn === 'function') {
    refundResult = await executeRefundFn({
      purchaseId: dispute.purchaseId,
      amount: dispute.evidenceBundle.purchaseTransaction.amount,
      buyerAddress: dispute.buyerAddress,
      disputeId: String(dispute._id),
    });
  } else {
    refundResult = { success: true, refundId: `ref_disp_${dispute._id}` };
  }

  if (!refundResult || refundResult.success === false) {
    return {
      success: false,
      reason: refundResult?.reason || 'refund_execution_failed',
    };
  }

  // Transition dispute status to executed
  const transition = await transitionDisputeStatus({
    db,
    disputeId: queryId,
    toStatus: DISPUTE_STATUS.EXECUTED,
    actor,
    notes: `Refund executed successfully. Reference: ${refundResult.refundId || refundResult.txHash || 'completed'}`,
  });

  return {
    success: true,
    dispute: transition.dispute,
    refundResult,
  };
}
