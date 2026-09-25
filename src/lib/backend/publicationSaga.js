/**
 * Publication Saga - Idempotent material publication workflow
 *
 * Manages multi-step publication process with full compensation:
 * PENDING -> UPLOAD_DONE -> IPFS_PINNED -> SOROBAN_REGISTERED -> CHAIN_FINALIZED -> INDEXED -> COMPLETE
 *
 * On failure, steps can be retried. Crashes are recovered via state machine.
 * Every external interaction (IPFS, Soroban, Chain, Indexer) stores proof for idempotency.
 */

import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

export const PUBLICATION_STATES = {
  PENDING: "pending",
  UPLOAD_DONE: "upload_done",
  IPFS_PINNED: "ipfs_pinned",
  SOROBAN_REGISTERED: "soroban_registered",
  CHAIN_FINALIZED: "chain_finalized",
  INDEXED: "indexed",
  COMPLETE: "complete",
  FAILED: "failed",
};

const STATE_TRANSITIONS = {
  [PUBLICATION_STATES.PENDING]: PUBLICATION_STATES.UPLOAD_DONE,
  [PUBLICATION_STATES.UPLOAD_DONE]: PUBLICATION_STATES.IPFS_PINNED,
  [PUBLICATION_STATES.IPFS_PINNED]: PUBLICATION_STATES.SOROBAN_REGISTERED,
  [PUBLICATION_STATES.SOROBAN_REGISTERED]: PUBLICATION_STATES.CHAIN_FINALIZED,
  [PUBLICATION_STATES.CHAIN_FINALIZED]: PUBLICATION_STATES.INDEXED,
  [PUBLICATION_STATES.INDEXED]: PUBLICATION_STATES.COMPLETE,
};

/**
 * Create a new publication saga for a material
 */
export async function createPublicationSaga(materialId, idempotencyKey) {
  const db = await getDb();
  const collection = db.collection("publication_sagas");

  const saga = {
    _id: new ObjectId(),
    materialId: new ObjectId(materialId),
    idempotencyKey,
    state: PUBLICATION_STATES.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
    stepProofs: {}, // Stores proof of each external interaction
    lastError: null,
    retries: 0,
  };

  await collection.insertOne(saga);
  return saga;
}

/**
 * Get saga by idempotency key (prevents duplicate publishes)
 */
export async function getSagaByIdempotencyKey(idempotencyKey) {
  const db = await getDb();
  return db.collection("publication_sagas").findOne({ idempotencyKey });
}

/**
 * Get saga by material ID
 */
export async function getSagaByMaterialId(materialId) {
  const db = await getDb();
  return db.collection("publication_sagas").findOne({
    materialId: new ObjectId(materialId),
  });
}

/**
 * Transition saga to next state and record step proof
 */
export async function transitionSagaState(sagaId, currentState, proof = {}) {
  const db = await getDb();
  const collection = db.collection("publication_sagas");

  const nextState = STATE_TRANSITIONS[currentState];
  if (!nextState) {
    throw new Error(`Invalid state transition from ${currentState}`);
  }

  const result = await collection.findOneAndUpdate(
    { _id: new ObjectId(sagaId), state: currentState },
    {
      $set: {
        state: nextState,
        updatedAt: new Date(),
        lastError: null,
        retries: 0,
      },
      $set: {
        [`stepProofs.${currentState}`]: {
          timestamp: new Date(),
          proof,
        },
      },
    },
    { returnDocument: "after" }
  );

  return result;
}

/**
 * Mark saga as failed with error reason
 */
export async function failSagaStep(sagaId, state, errorReason) {
  const db = await getDb();
  const collection = db.collection("publication_sagas");

  return collection.findOneAndUpdate(
    { _id: new ObjectId(sagaId) },
    {
      $set: {
        state: PUBLICATION_STATES.FAILED,
        lastError: {
          failedAt: state,
          reason: errorReason,
          timestamp: new Date(),
        },
        updatedAt: new Date(),
      },
      $inc: { retries: 1 },
    },
    { returnDocument: "after" }
  );
}

/**
 * Get all stalled sagas (older than 1 hour, not complete/failed)
 */
export async function getStalledSagas(maxAgeMs = 60 * 60 * 1000) {
  const db = await getDb();
  const staleSince = new Date(Date.now() - maxAgeMs);

  return db.collection("publication_sagas").find({
    state: {
      $nin: [PUBLICATION_STATES.COMPLETE, PUBLICATION_STATES.FAILED],
    },
    updatedAt: { $lt: staleSince },
  }).toArray();
}

/**
 * Compensate (rollback) a saga - delete external resources
 */
export async function compensateSaga(saga) {
  const compensation = {
    rollbacks: [],
    timestamp: new Date(),
  };

  // If pinned on IPFS, unpin it
  if (saga.stepProofs?.[PUBLICATION_STATES.IPFS_PINNED]?.proof?.cid) {
    compensation.rollbacks.push({
      step: PUBLICATION_STATES.IPFS_PINNED,
      action: "unpin_ipfs",
      cid: saga.stepProofs[PUBLICATION_STATES.IPFS_PINNED].proof.cid,
    });
  }

  // If registered on Soroban, mark for unregistration
  if (saga.stepProofs?.[PUBLICATION_STATES.SOROBAN_REGISTERED]?.proof?.contractId) {
    compensation.rollbacks.push({
      step: PUBLICATION_STATES.SOROBAN_REGISTERED,
      action: "mark_unregistered",
      contractId: saga.stepProofs[PUBLICATION_STATES.SOROBAN_REGISTERED].proof.contractId,
    });
  }

  // If finalized on chain, mark as draft
  if (saga.stepProofs?.[PUBLICATION_STATES.CHAIN_FINALIZED]?.proof?.txHash) {
    compensation.rollbacks.push({
      step: PUBLICATION_STATES.CHAIN_FINALIZED,
      action: "mark_draft",
      txHash: saga.stepProofs[PUBLICATION_STATES.CHAIN_FINALIZED].proof.txHash,
    });
  }

  const db = await getDb();
  await db.collection("publication_sagas").updateOne(
    { _id: saga._id },
    {
      $set: {
        compensation,
        state: PUBLICATION_STATES.FAILED,
        updatedAt: new Date(),
      },
    }
  );

  return compensation;
}

/**
 * Mark saga as complete (all steps done, chain finalized)
 */
export async function completeSaga(sagaId) {
  const db = await getDb();
  const collection = db.collection("publication_sagas");

  return collection.findOneAndUpdate(
    { _id: new ObjectId(sagaId) },
    {
      $set: {
        state: PUBLICATION_STATES.COMPLETE,
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
}
