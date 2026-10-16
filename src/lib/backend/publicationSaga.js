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

export const STATE_TRANSITIONS = {
  [PUBLICATION_STATES.PENDING]: PUBLICATION_STATES.UPLOAD_DONE,
  [PUBLICATION_STATES.UPLOAD_DONE]: PUBLICATION_STATES.IPFS_PINNED,
  [PUBLICATION_STATES.IPFS_PINNED]: PUBLICATION_STATES.SOROBAN_REGISTERED,
  [PUBLICATION_STATES.SOROBAN_REGISTERED]: PUBLICATION_STATES.CHAIN_FINALIZED,
  [PUBLICATION_STATES.CHAIN_FINALIZED]: PUBLICATION_STATES.INDEXED,
  [PUBLICATION_STATES.INDEXED]: PUBLICATION_STATES.COMPLETE,
};

/** `complete` is the success terminal; `failed` is recoverable until compensated. */
export const SAGA_TERMINAL_STATES = Object.freeze([PUBLICATION_STATES.COMPLETE]);

/** Forward (happy-path) steps, in order. */
export const SAGA_STEP_ORDER = Object.freeze([
  PUBLICATION_STATES.PENDING,
  PUBLICATION_STATES.UPLOAD_DONE,
  PUBLICATION_STATES.IPFS_PINNED,
  PUBLICATION_STATES.SOROBAN_REGISTERED,
  PUBLICATION_STATES.CHAIN_FINALIZED,
  PUBLICATION_STATES.INDEXED,
  PUBLICATION_STATES.COMPLETE,
]);

/**
 * Full explicit edge check:
 *  - each step advances to exactly its successor;
 *  - any non-terminal, non-failed step may fail;
 *  - `failed` may only recover to the step recorded in `lastError.failedAt`
 *    (pass it as `failedAt`), and only to a non-terminal step;
 *  - `complete` has no outgoing edges.
 */
export function isValidSagaTransition(fromState, toState, { failedAt } = {}) {
  if (STATE_TRANSITIONS[fromState] === toState) return true;
  if (toState === PUBLICATION_STATES.FAILED) {
    return fromState !== PUBLICATION_STATES.COMPLETE && fromState !== PUBLICATION_STATES.FAILED && SAGA_STEP_ORDER.includes(fromState);
  }
  if (fromState === PUBLICATION_STATES.FAILED) {
    return Boolean(failedAt) && toState === failedAt && Object.hasOwn(STATE_TRANSITIONS, failedAt);
  }
  return false;
}

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
      // A single $set: a duplicate key here silently drops the first block,
      // which previously meant the state never advanced.
      $set: {
        state: nextState,
        updatedAt: new Date(),
        lastError: null,
        retries: 0,
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

  // Fail only the step the caller actually observed. A late or stale report
  // (the saga already advanced, completed, or failed) is a no-op, so the
  // recorded failure point is always the real one and a later retry can never
  // rewind past a step that already succeeded.
  if (!Object.hasOwn(STATE_TRANSITIONS, state)) return null;
  return collection.findOneAndUpdate(
    { _id: new ObjectId(sagaId), state },
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
  const result = await db.collection("publication_sagas").updateOne(
    { _id: saga._id, state: { $ne: PUBLICATION_STATES.COMPLETE } },
    {
      $set: {
        compensation,
        state: PUBLICATION_STATES.FAILED,
        updatedAt: new Date(),
      },
    }
  );

  if (result && result.matchedCount === 0) {
    throw new Error(`Cannot compensate saga ${String(saga._id)}: missing or already complete`);
  }

  return compensation;
}

/**
 * Recovery path: move a failed saga back to the step it failed at so the
 * worker can retry it. Refused (returns null) when the saga is not failed,
 * has no valid failure point, or was already compensated — external resources
 * were rolled back, so resuming mid-flight would be unsafe.
 */
export async function retrySagaFromFailure(sagaId) {
  const db = await getDb();
  const collection = db.collection("publication_sagas");
  const _id = new ObjectId(sagaId);

  const saga = await collection.findOne({ _id });
  if (!saga || saga.state !== PUBLICATION_STATES.FAILED || saga.compensation) return null;

  const failedAt = saga.lastError?.failedAt;
  if (!isValidSagaTransition(PUBLICATION_STATES.FAILED, failedAt, { failedAt })) return null;

  return collection.findOneAndUpdate(
    // Also match the failure point we validated: if the saga was retried and
    // failed again meanwhile, this stale retry must not rewind it.
    { _id, state: PUBLICATION_STATES.FAILED, "lastError.failedAt": failedAt },
    { $set: { state: failedAt, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
}

/**
 * Mark saga as complete (all steps done, chain finalized)
 */
export async function completeSaga(sagaId) {
  const db = await getDb();
  const collection = db.collection("publication_sagas");

  // Only an indexed saga may complete; failed/in-flight sagas are never promoted.
  return collection.findOneAndUpdate(
    { _id: new ObjectId(sagaId), state: PUBLICATION_STATES.INDEXED },
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
