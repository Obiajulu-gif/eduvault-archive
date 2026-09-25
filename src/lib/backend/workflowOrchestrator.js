/**
 * Workflow Orchestration for Material Registration and Purchase
 * 
 * This module provides server-side workflow state management for multi-step
 * blockchain operations, including retry logic, reconciliation, and idempotency.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS, applyTimestamps } from "./schemaContracts";

// Workflow states
export const WORKFLOW_STATES = {
  PENDING: "pending",
  SUBMITTED: "submitted",
  CONFIRMED: "confirmed",
  FAILED: "failed",
  NEEDS_RECONCILIATION: "needs_reconciliation",
};

// Workflow types
export const WORKFLOW_TYPES = {
  MATERIAL_REGISTRATION: "material_registration",
  PURCHASE: "purchase",
};

/**
 * Create a new workflow record
 * @param {Object} params
 * @param {string} params.type - Workflow type (material_registration | purchase)
 * @param {string} params.userAddress - User wallet address
 * @param {Object} params.metadata - Additional metadata
 * @returns {Promise<Object>} Created workflow record
 */
export async function createWorkflow({ type, userAddress, metadata = {} }) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  const workflow = applyTimestamps({
    type,
    userAddress: userAddress.toLowerCase(),
    state: WORKFLOW_STATES.PENDING,
    metadata,
    retries: 0,
    maxRetries: metadata.maxRetries || 5,
    lastRetryAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const result = await collection.insertOne(workflow);
  return { ...workflow, _id: result.insertedId };
}

/**
 * Update workflow state
 * @param {string} workflowId - Workflow ID
 * @param {string} newState - New workflow state
 * @param {Object} updates - Additional updates
 * @returns {Promise<Object|null>} Updated workflow
 */
export async function updateWorkflowState(workflowId, newState, updates = {}) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  const result = await collection.findOneAndUpdate(
    { _id: workflowId },
    {
      $set: applyTimestamps({
        state: newState,
        ...updates,
      }),
    },
    { returnDocument: "after" }
  );

  return result;
}

/**
 * Add retry attempt to workflow
 * @param {string} workflowId - Workflow ID
 * @param {string} errorReason - Reason for retry
 * @returns {Promise<Object|null>} Updated workflow
 */
export async function addRetryAttempt(workflowId, errorReason) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  const workflow = await collection.findOne({ _id: workflowId });
  if (!workflow) return null;

  const newRetries = (workflow.retries || 0) + 1;

  if (newRetries >= workflow.maxRetries) {
    return updateWorkflowState(workflowId, WORKFLOW_STATES.NEEDS_RECONCILIATION, {
      retryError: errorReason,
      lastRetryAt: new Date(),
      retries: newRetries,
    });
  }

  return updateWorkflowState(workflowId, workflow.state, {
    retryError: errorReason,
    lastRetryAt: new Date(),
    retries: newRetries,
  });
}

/**
 * Get workflow by ID
 * @param {string} workflowId - Workflow ID
 * @returns {Promise<Object|null>} Workflow record
 */
export async function getWorkflow(workflowId) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);
  return collection.findOne({ _id: workflowId });
}

/**
 * Get workflows by user address
 * @param {string} userAddress - User wallet address
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Array of workflows
 */
export async function getWorkflowsByUser(userAddress, options = {}) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);
  const { type, state, limit = 50, skip = 0 } = options;

  const query = { userAddress: userAddress.toLowerCase() };
  if (type) query.type = type;
  if (state) query.state = state;

  return collection
    .find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

/**
 * Get workflows needing reconciliation
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Array of workflows
 */
export async function getWorkflowsNeedingReconciliation(options = {}) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);
  const { limit = 100 } = options;

  return collection
    .find({
      $or: [
        { state: WORKFLOW_STATES.NEEDS_RECONCILIATION },
        {
          state: WORKFLOW_STATES.SUBMITTED,
          lastRetryAt: {
            $lt: new Date(Date.now() - 15 * 60 * 1000), // Older than 15 minutes
          },
        },
      ],
    })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();
}

/**
 * Mark workflow as confirmed with transaction details
 * @param {string} workflowId - Workflow ID
 * @param {Object} txDetails - Transaction details
 * @returns {Promise<Object|null>} Updated workflow
 */
export async function confirmWorkflow(workflowId, txDetails) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  return updateWorkflowState(workflowId, WORKFLOW_STATES.CONFIRMED, {
    txHash: txDetails.txHash,
    blockNumber: txDetails.blockNumber,
    tokenId: txDetails.tokenId,
    confirmedAt: new Date(),
  });
}

/**
 * Mark workflow as failed
 * @param {string} workflowId - Workflow ID
 * @param {string} errorReason - Failure reason
 * @returns {Promise<Object|null>} Updated workflow
 */
export async function failWorkflow(workflowId, errorReason) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  return updateWorkflowState(workflowId, WORKFLOW_STATES.FAILED, {
    errorReason,
    failedAt: new Date(),
  });
}

/**
 * Check idempotency - prevent duplicate workflow creation
 * @param {string} type - Workflow type
 * @param {string} userAddress - User address
 * @param {string} idempotencyKey - Unique key for the operation
 * @returns {Promise<Object|null>} Existing workflow if found
 */
export async function checkIdempotency(type, userAddress, idempotencyKey) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  return collection.findOne({
    type,
    userAddress: userAddress.toLowerCase(),
    "metadata.idempotencyKey": idempotencyKey,
    state: {
      $in: [
        WORKFLOW_STATES.PENDING,
        WORKFLOW_STATES.SUBMITTED,
        WORKFLOW_STATES.CONFIRMED,
      ],
    },
  });
}

/**
 * Persist a canonical material record in MongoDB after a confirmed mint
 * @param {string} workflowId - Workflow ID
 * @param {Object} materialData - Material data
 * @returns {Promise<Object>} Persisted material record
 */
export async function persistMaterialRecord(workflowId, materialData) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.materials);

  const materialRecord = applyTimestamps({
    userAddress: materialData.userAddress,
    tokenId: materialData.tokenId,
    txHash: materialData.txHash,
    chainId: materialData.chainId,
    metadataUrl: materialData.metadataUrl,
    fileUrl: materialData.fileUrl,
    thumbnailUrl: materialData.thumbnailUrl,
    price: materialData.price,
    visibility: materialData.visibility,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await collection.insertOne(materialRecord);
  await confirmWorkflow(workflowId, {
    txHash: materialData.txHash,
    tokenId: materialData.tokenId,
  });

  return materialRecord;
}

/**
 * Leases & Fencing Token support (Stellar Wave issue #632)
 *
 * Multiple workers can otherwise select the same pending workflow, or a slow
 * worker can commit after its lease has been reassigned. We make every unit of
 * work claimable with an atomic lease that records the owner, a monotonic
 * generation, a lease expiry, and a fencing token. Every state transition and
 * heartbeat must present the *current* fencing token or it is rejected, which
 * prevents a stale worker from committing work that was already reassigned.
 */

// Default lease window. Short enough that a crashed/partitioned worker is
// reclaimed quickly, long enough for a healthy worker to finish a unit of work.
export const WORKFLOW_LEASE_DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes
export const WORKFLOW_POISONED_STATE = "poisoned";

export class FencingTokenMismatchError extends Error {
  constructor(workflowId) {
    super(
      `Fencing token rejected for workflow ${workflowId}. ` +
        `The lease was reassigned to another worker; this unit of work is stale.`
    );
    this.name = "FencingTokenMismatchError";
    this.workflowId = workflowId;
  }
}

function newFencingToken() {
  // The fencing token is globally unique per claim. Combined with the monotonic
  // `generation` counter (incremented on every claim/transition), operators get
  // a stable ordering while the token itself guarantees that only the current
  // lease owner can drive a state transition.
  return randomUUID();
}

/**
 * Atomically claim the next workflow needing work, assigning an owner,
 * generation, lease expiry, and fencing token. Returns the claimed workflow
 * (with the active `fencingToken`) or `null` when nothing is claimable.
 *
 * Two workers can never own the same generation: the claim uses a single
 * atomic findOneAndUpdate, so the winner overwrites `fencingToken` and bumps
 * `generation`; the loser simply finds no matching document.
 */
export async function claimWorkflowForProcessing(
  workerId,
  { leaseTtlMs = WORKFLOW_LEASE_DEFAULT_TTL_MS, now = new Date() } = {}
) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  const query = {
    poisoned: { $ne: true },
    $and: [
      {
        $or: [
          { state: WORKFLOW_STATES.NEEDS_RECONCILIATION },
          {
            state: WORKFLOW_STATES.SUBMITTED,
            lastRetryAt: { $lt: new Date(now.getTime() - 15 * 60 * 1000) },
          },
        ],
      },
      {
        $or: [{ leaseExpiresAt: { $lte: now } }, { leaseExpiresAt: null }],
      },
    ],
  };

  const claimed = await collection.findOneAndUpdate(
    query,
    {
      $set: {
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseTtlMs),
        fencingToken: newFencingToken(),
        updatedAt: now,
      },
      $inc: { generation: 1, claimCount: 1 },
    },
    { sort: { updatedAt: 1 }, returnDocument: "after" }
  );

  if (!claimed) return null;
  const doc = claimed.value || claimed;
  return doc;
}

/**
 * Renew the lease (heartbeat) for work in progress. Requires the active
 * fencing token and owner, so a reassigned lease cannot be kept alive by a
 * partitioned worker.
 */
export async function renewWorkflowLease(
  workflowId,
  fencingToken,
  workerId,
  { leaseTtlMs = WORKFLOW_LEASE_DEFAULT_TTL_MS, now = new Date() } = {}
) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  const result = await collection.findOneAndUpdate(
    {
      _id: workflowId,
      fencingToken,
      leaseOwner: workerId,
      leaseExpiresAt: { $gt: now },
    },
    {
      $set: {
        leaseExpiresAt: new Date(now.getTime() + leaseTtlMs),
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  if (!result) {
    throw new FencingTokenMismatchError(workflowId);
  }
  return result;
}

/**
 * Transition a workflow's state. Requires the active fencing token, owner, and
 * a live lease. On success the lease is released, the generation is advanced,
 * and the fencing token is cleared so the token can never be reused.
 */
export async function transitionWorkflow(
  workflowId,
  fencingToken,
  newState,
  updates = {},
  { now = new Date() } = {}
) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  const result = await collection.findOneAndUpdate(
    {
      _id: workflowId,
      fencingToken,
      leaseExpiresAt: { $gt: now },
    },
    {
      $set: applyTimestamps(
        {
          state: newState,
          ...updates,
          leaseOwner: null,
          leaseExpiresAt: null,
          fencingToken: null,
        },
        now
      ),
      $inc: { generation: 1 },
    },
    { returnDocument: "after" }
  );

  if (!result) {
    throw new FencingTokenMismatchError(workflowId);
  }
  return result;
}

/**
 * Mark a workflow as poisoned after repeated failed attempts. The lease is
 * released so nothing else can pick it up until an operator recovers it.
 */
export async function poisonWorkflow(workflowId, reason, { now = new Date() } = {}) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  return collection.findOneAndUpdate(
    { _id: workflowId },
    {
      $set: applyTimestamps(
        {
          state: WORKFLOW_POISONED_STATE,
          poisoned: true,
          poisonReason: reason,
          leaseOwner: null,
          leaseExpiresAt: null,
          fencingToken: null,
        },
        now
      ),
    },
    { returnDocument: "after" }
  );
}

/**
 * Operator recovery: return a poisoned/abandoned workflow to the queue. A new
 * generation is minted and the lease cleared so a fresh claim can pick it up.
 */
export async function recoverWorkflow(workflowId, { reason, now = new Date() } = {}) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  return collection.findOneAndUpdate(
    { _id: workflowId },
    {
      $set: applyTimestamps(
        {
          state: WORKFLOW_STATES.NEEDS_RECONCILIATION,
          poisoned: false,
          poisonReason: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          fencingToken: null,
          retries: 0,
          recoveryNote: reason || "Recovered by operator",
          recoveredAt: now,
        },
        now
      ),
      $inc: { generation: 1 },
    },
    { returnDocument: "after" }
  );
}

/**
 * Confirm a workflow, optionally gated by the active fencing token. When a
 * fencing token is supplied the transition is rejected if the lease has been
 * reassigned, preventing a stale worker from committing after reassignment.
 */
export async function confirmWorkflow(workflowId, txDetails, { fencingToken } = {}) {
  const updates = {
    txHash: txDetails.txHash,
    blockNumber: txDetails.blockNumber,
    tokenId: txDetails.tokenId,
    confirmedAt: new Date(),
  };

  if (fencingToken) {
    return transitionWorkflow(workflowId, fencingToken, WORKFLOW_STATES.CONFIRMED, updates);
  }

  return updateWorkflowState(workflowId, WORKFLOW_STATES.CONFIRMED, updates);
}

/**
 * Fail a workflow, optionally gated by the active fencing token.
 */
export async function failWorkflow(workflowId, errorReason, { fencingToken } = {}) {
  const updates = {
    errorReason,
    failedAt: new Date(),
  };

  if (fencingToken) {
    return transitionWorkflow(workflowId, fencingToken, WORKFLOW_STATES.FAILED, updates);
  }

  return updateWorkflowState(workflowId, WORKFLOW_STATES.FAILED, updates);
}

/**
 * Record a retry against a fenced workflow. Uses the fencing token so a
 * reassigned worker cannot clobber retry bookkeeping. When retries are
 * exhausted the workflow becomes poisoned.
 */
export async function addRetryAttempt(workflowId, errorReason, { fencingToken, now = new Date() } = {}) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.syncState);

  const workflow = await collection.findOne({ _id: workflowId });
  if (!workflow) return null;

  const maxRetries = workflow.maxRetries || 5;
  const newRetries = (workflow.retries || 0) + 1;

  if (newRetries >= maxRetries) {
    if (fencingToken) {
      return transitionWorkflow(workflowId, fencingToken, WORKFLOW_POISONED_STATE, {
        poisoned: true,
        poisonReason: `Max retries (${maxRetries}) exceeded: ${errorReason}`,
        retryError: errorReason,
        lastRetryAt: now,
        retries: newRetries,
      });
    }
    return updateWorkflowState(workflowId, WORKFLOW_POISONED_STATE, {
      poisoned: true,
      poisonReason: `Max retries (${maxRetries}) exceeded: ${errorReason}`,
      retryError: errorReason,
      lastRetryAt: now,
      retries: newRetries,
    });
  }

  if (fencingToken) {
    return transitionWorkflow(workflowId, fencingToken, workflow.state, {
      retryError: errorReason,
      lastRetryAt: now,
      retries: newRetries,
    });
  }
  return updateWorkflowState(workflowId, workflow.state, {
    retryError: errorReason,
    lastRetryAt: now,
    retries: newRetries,
  });
}
