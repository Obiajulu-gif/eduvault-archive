/**
 * Workflow Orchestration for Material Registration and Purchase
 * 
 * This module provides server-side workflow state management for multi-step
 * blockchain operations, including retry logic, reconciliation, and idempotency.
 */

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
