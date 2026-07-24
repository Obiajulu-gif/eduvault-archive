/**
 * Deletion State Machine
 *
 * States
 * ──────
 *  pending_reauth       – request created; user must re-authenticate to confirm
 *  cooling_off          – re-auth complete; 14-day cooling-off window starts
 *  cancelled            – user cancelled during cooling-off; terminal
 *  executing            – cooling-off elapsed; deletion job is running
 *  completed            – all steps finished; receipt issued
 *  failed               – a step failed; can be retried (idempotent)
 *
 * Allowed transitions
 * ───────────────────
 *  pending_reauth  → cooling_off   (after successful re-auth)
 *  pending_reauth  → cancelled     (user cancels before re-auth)
 *  cooling_off     → cancelled     (user cancels within cooling-off window)
 *  cooling_off     → executing     (cooling-off period expired + obligations clear)
 *  executing       → completed
 *  executing       → failed        (partial failure; retry safe)
 *  failed          → executing     (manual or scheduled retry)
 */

import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb.js";
import { auditLog } from "@/lib/api/audit.js";
import { checkObligations } from "./obligationChecker.js";

export const DELETION_STATUS = Object.freeze({
  PENDING_REAUTH: "pending_reauth",
  COOLING_OFF:    "cooling_off",
  CANCELLED:      "cancelled",
  EXECUTING:      "executing",
  COMPLETED:      "completed",
  FAILED:         "failed",
});

// GDPR Art. 12(3): requests must be addressed within one month.
// We use a 14-day cooling-off window to give users time to change their minds.
export const COOLING_OFF_DAYS = 14;
export const COOLING_OFF_MS   = COOLING_OFF_DAYS * 24 * 60 * 60 * 1000;

// Re-auth challenge expires after 30 minutes
export const REAUTH_WINDOW_MS = 30 * 60 * 1000;

const ALLOWED_TRANSITIONS = {
  [DELETION_STATUS.PENDING_REAUTH]: [DELETION_STATUS.COOLING_OFF, DELETION_STATUS.CANCELLED],
  [DELETION_STATUS.COOLING_OFF]:    [DELETION_STATUS.CANCELLED,   DELETION_STATUS.EXECUTING],
  [DELETION_STATUS.EXECUTING]:      [DELETION_STATUS.COMPLETED,   DELETION_STATUS.FAILED],
  [DELETION_STATUS.FAILED]:         [DELETION_STATUS.EXECUTING],
};

export class DeletionStateMachineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DeletionStateMachineError";
    this.code = code;
  }
}

function assertTransition(from, to) {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new DeletionStateMachineError(
      `Transition ${from} → ${to} is not allowed`,
      "invalid_transition"
    );
  }
}

function normalizeId(id) {
  return String(id);
}

// ─── Queries ───────────────────────────────────────────────────────────────

export async function getDeletionRequest(requestId, userId) {
  const db = await getDb();
  const doc = await db.collection("deletion_requests").findOne({
    _id: new ObjectId(requestId),
  });
  if (!doc) throw new DeletionStateMachineError("Not found", "not_found");
  if (doc.userId !== normalizeId(userId)) {
    throw new DeletionStateMachineError("Forbidden", "forbidden");
  }
  return doc;
}

export async function getActiveDeletionRequest(userId) {
  const db = await getDb();
  return db.collection("deletion_requests").findOne({
    userId: normalizeId(userId),
    status: { $nin: [DELETION_STATUS.CANCELLED, DELETION_STATUS.COMPLETED] },
  });
}

// ─── State transitions ─────────────────────────────────────────────────────

/**
 * STEP 1 — Create a deletion request.
 * Issues a re-auth challenge token. The user must call confirmReauth()
 * within REAUTH_WINDOW_MS to advance to cooling_off.
 */
export async function createDeletionRequest(userId, walletAddress) {
  const db = await getDb();

  // Idempotency: only one active request per user
  const active = await getActiveDeletionRequest(userId);
  if (active) {
    return { alreadyExists: true, request: active };
  }

  const reauthToken = crypto.randomBytes(32).toString("hex");
  const now = new Date();

  const doc = {
    userId:         normalizeId(userId),
    walletAddress:  walletAddress ?? null,
    status:         DELETION_STATUS.PENDING_REAUTH,
    reauthToken,
    reauthExpiresAt: new Date(now.getTime() + REAUTH_WINDOW_MS),
    coolingOffEndsAt: null,
    executionStartedAt: null,
    completedAt:    null,
    cancelledAt:    null,
    failureReason:  null,
    steps:          [],
    receiptId:      null,
    requestedAt:    now,
    updatedAt:      now,
  };

  const result = await db.collection("deletion_requests").insertOne(doc);
  auditLog({ event: "deletion_requested", actor: normalizeId(userId), outcome: "pending_reauth" });
  return { alreadyExists: false, request: { ...doc, _id: result.insertedId } };
}

/**
 * STEP 2 — Confirm re-authentication.
 * Validates the reauthToken and advances the request to cooling_off.
 */
export async function confirmReauth(requestId, userId, reauthToken) {
  const db = await getDb();
  const doc = await getDeletionRequest(requestId, userId);

  if (doc.status !== DELETION_STATUS.PENDING_REAUTH) {
    throw new DeletionStateMachineError(
      `Cannot confirm reauth in status: ${doc.status}`,
      "invalid_transition"
    );
  }
  if (doc.reauthExpiresAt < new Date()) {
    throw new DeletionStateMachineError("Re-auth challenge has expired", "reauth_expired");
  }
  if (doc.reauthToken !== reauthToken) {
    throw new DeletionStateMachineError("Invalid re-auth token", "invalid_token");
  }

  assertTransition(DELETION_STATUS.PENDING_REAUTH, DELETION_STATUS.COOLING_OFF);

  const now = new Date();
  const coolingOffEndsAt = new Date(now.getTime() + COOLING_OFF_MS);

  await db.collection("deletion_requests").updateOne(
    { _id: doc._id },
    {
      $set: {
        status:          DELETION_STATUS.COOLING_OFF,
        coolingOffEndsAt,
        updatedAt:       now,
        reauthToken:     null, // consume the token
      },
    }
  );

  auditLog({ event: "deletion_reauth_confirmed", actor: normalizeId(userId), outcome: "cooling_off" });
  return { status: DELETION_STATUS.COOLING_OFF, coolingOffEndsAt };
}

/**
 * STEP 3 (optional) — Cancel during cooling-off (or before re-auth).
 */
export async function cancelDeletionRequest(requestId, userId, reason = null) {
  const db = await getDb();
  const doc = await getDeletionRequest(requestId, userId);

  const cancellable = [DELETION_STATUS.PENDING_REAUTH, DELETION_STATUS.COOLING_OFF];
  if (!cancellable.includes(doc.status)) {
    throw new DeletionStateMachineError(
      `Cannot cancel deletion in status: ${doc.status}`,
      "invalid_transition"
    );
  }

  await db.collection("deletion_requests").updateOne(
    { _id: doc._id },
    {
      $set: {
        status:      DELETION_STATUS.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: reason ?? null,
        updatedAt:   new Date(),
      },
    }
  );

  auditLog({ event: "deletion_cancelled", actor: normalizeId(userId), outcome: "cancelled" });
  return { status: DELETION_STATUS.CANCELLED };
}

/**
 * STEP 4 — Advance to executing after cooling-off expires.
 * Called by the background job scheduler. Also checks active obligations.
 */
export async function advanceToExecuting(requestId) {
  const db = await getDb();
  const doc = await db.collection("deletion_requests").findOne({
    _id: new ObjectId(requestId),
  });
  if (!doc) throw new DeletionStateMachineError("Not found", "not_found");
  if (doc.status !== DELETION_STATUS.COOLING_OFF) {
    throw new DeletionStateMachineError(
      `Cannot advance to executing from status: ${doc.status}`,
      "invalid_transition"
    );
  }
  if (doc.coolingOffEndsAt > new Date()) {
    throw new DeletionStateMachineError("Cooling-off period has not ended", "cooling_off_active");
  }

  // Check financial/escrow obligations
  const { blocked, reasons } = await checkObligations(doc.userId, doc.walletAddress);
  if (blocked) {
    await db.collection("deletion_requests").updateOne(
      { _id: doc._id },
      { $set: { updatedAt: new Date(), obligationBlockReasons: reasons } }
    );
    throw new DeletionStateMachineError(
      `Deletion blocked by active obligations: ${reasons.join("; ")}`,
      "obligations_blocked"
    );
  }

  assertTransition(DELETION_STATUS.COOLING_OFF, DELETION_STATUS.EXECUTING);

  await db.collection("deletion_requests").updateOne(
    { _id: doc._id },
    {
      $set: {
        status:             DELETION_STATUS.EXECUTING,
        executionStartedAt: new Date(),
        obligationBlockReasons: null,
        updatedAt:          new Date(),
      },
    }
  );

  auditLog({ event: "deletion_execution_started", actor: doc.userId });
  return { status: DELETION_STATUS.EXECUTING };
}

/**
 * Record a completed execution step (partial progress, idempotent).
 */
export async function recordDeletionStep(requestId, step) {
  const db = await getDb();
  await db.collection("deletion_requests").updateOne(
    { _id: new ObjectId(requestId) },
    {
      $push: { steps: { ...step, recordedAt: new Date() } },
      $set:  { updatedAt: new Date() },
    }
  );
}

/**
 * STEP 5 — Mark deletion complete and issue a receipt.
 */
export async function completeDeletion(requestId) {
  const db = await getDb();
  const doc = await db.collection("deletion_requests").findOne({
    _id: new ObjectId(requestId),
  });
  if (!doc) throw new DeletionStateMachineError("Not found", "not_found");

  assertTransition(doc.status, DELETION_STATUS.COMPLETED);

  const receiptId = crypto.randomUUID();
  const completedAt = new Date();

  await db.collection("deletion_requests").updateOne(
    { _id: doc._id },
    {
      $set: {
        status:      DELETION_STATUS.COMPLETED,
        completedAt,
        receiptId,
        updatedAt:   completedAt,
        failureReason: null,
      },
    }
  );

  auditLog({ event: "deletion_completed", actor: doc.userId, outcome: "completed" });
  return { receiptId, completedAt };
}

/**
 * Record a failed execution (partial failure; allows retry).
 */
export async function failDeletion(requestId, reason) {
  const db = await getDb();
  const doc = await db.collection("deletion_requests").findOne({
    _id: new ObjectId(requestId),
  });
  if (!doc) throw new DeletionStateMachineError("Not found", "not_found");

  assertTransition(doc.status, DELETION_STATUS.FAILED);

  await db.collection("deletion_requests").updateOne(
    { _id: doc._id },
    {
      $set: {
        status:        DELETION_STATUS.FAILED,
        failureReason: reason,
        updatedAt:     new Date(),
      },
    }
  );

  auditLog({ event: "deletion_failed", actor: doc.userId, reason });
}

/**
 * Ensure required indexes for the deletion_requests collection.
 */
export async function ensureDeletionIndexes(db) {
  const col = db.collection("deletion_requests");
  await col.createIndex({ userId: 1, status: 1 });
  await col.createIndex({ status: 1, coolingOffEndsAt: 1 });
  await col.createIndex({ completedAt: 1 });
}
