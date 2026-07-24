/**
 * Deletion Executor
 *
 * Orchestrates all deletion steps for a confirmed account deletion request.
 * Every step is idempotent; the executor can be retried safely on partial failure.
 *
 * Steps (in order):
 *   1. Revoke all auth sessions (refresh tokens)
 *   2. Delete session-like collections (auth_challenges, upload_sessions)
 *   3. Delete user-owned non-financial records
 *   4. Anonymize retained financial/audit records
 *   5. Unpin IPFS/Pinata objects (avatar; materials only if no other buyers hold entitlements)
 *   6. Delete the user profile document
 *   7. Mark deletion completed and issue receipt
 */

import { getDb } from "@/lib/mongodb.js";
import { revokeRefreshTokensForUser } from "@/lib/auth/tokenService.js";
import { anonymizeUserData } from "./anonymizationService.js";
import {
  advanceToExecuting,
  recordDeletionStep,
  completeDeletion,
  failDeletion,
  getDeletionRequest,
  DELETION_STATUS,
} from "./deletionStateMachine.js";
import { unpinUserObjects } from "./storageCleanup.js";
import { ObjectId } from "mongodb";

const COLLECTIONS_TO_DELETE = [
  "saved_materials",
  "collections",
  "progress",
  "webhooks",
  "webhook_deliveries",
  "outbox",
  "upload_sessions",
  "auth_challenges",
  "refresh_tokens",
  "data_export_requests",
];

/**
 * Run the full deletion pipeline for a given requestId.
 * Can be called from an API route or a background job.
 *
 * @param {string} requestId   – deletion_requests._id
 * @param {string} userId      – validated user ID
 */
export async function executeDeletion(requestId, userId) {
  const db = await getDb();

  // Advance state to EXECUTING (validates cooling-off + obligations)
  await advanceToExecuting(requestId);

  const doc = await getDeletionRequest(requestId, userId);
  const wallet = doc.walletAddress;

  try {
    // ── Step 1: Revoke all auth sessions ───────────────────────────────────
    await revokeRefreshTokensForUser(userId);
    await recordDeletionStep(requestId, { step: "revoke_sessions", ok: true });

    // ── Step 2: Delete small session-like collections ─────────────────────
    for (const coll of ["auth_challenges", "upload_sessions"]) {
      const filter = buildDeleteFilter(coll, userId, wallet);
      if (filter) {
        const result = await db.collection(coll).deleteMany(filter);
        await recordDeletionStep(requestId, { step: `delete_${coll}`, deleted: result.deletedCount, ok: true });
      }
    }

    // ── Step 3: Delete user-owned non-financial records ───────────────────
    const deleteCollections = [
      "saved_materials",
      "collections",
      "progress",
      "webhooks",
      "webhook_deliveries",
      "outbox",
      "refresh_tokens",
      "data_export_requests",
    ];

    for (const coll of deleteCollections) {
      const filter = buildDeleteFilter(coll, userId, wallet);
      if (filter) {
        const result = await db.collection(coll).deleteMany(filter);
        await recordDeletionStep(requestId, { step: `delete_${coll}`, deleted: result.deletedCount, ok: true });
      }
    }

    // ── Step 4: Anonymize retained financial / audit records ──────────────
    const anonymizeResults = await anonymizeUserData(userId, wallet);
    await recordDeletionStep(requestId, { step: "anonymize_retained", results: anonymizeResults, ok: true });

    // ── Step 5: Unpin IPFS objects ────────────────────────────────────────
    try {
      const unpinResults = await unpinUserObjects(userId, wallet);
      await recordDeletionStep(requestId, { step: "unpin_ipfs", results: unpinResults, ok: true });
    } catch (err) {
      // IPFS unpin failure is non-fatal; log and continue
      await recordDeletionStep(requestId, { step: "unpin_ipfs", ok: false, error: err.message });
    }

    // ── Step 6: Delete the user profile document ──────────────────────────
    const userFilter = ObjectId.isValid(userId)
      ? { _id: new ObjectId(userId) }
      : wallet
        ? { $or: [{ walletAddress: wallet }, { walletAddressLower: wallet.toLowerCase() }] }
        : null;

    if (userFilter) {
      const userResult = await db.collection("users").deleteOne(userFilter);
      await recordDeletionStep(requestId, { step: "delete_user_profile", deleted: userResult.deletedCount, ok: true });
    }

    // ── Step 7: Complete ──────────────────────────────────────────────────
    const { receiptId, completedAt } = await completeDeletion(requestId);
    return { ok: true, receiptId, completedAt };

  } catch (err) {
    await failDeletion(requestId, err.message);
    throw err;
  }
}

/**
 * Build an ownership filter for "delete" collections.
 */
function buildDeleteFilter(collection, userId, wallet) {
  switch (collection) {
    case "refresh_tokens":
      return { userId: String(userId) };
    case "auth_challenges":
      return wallet ? { account: wallet } : null;
    case "upload_sessions":
      return { ownerId: String(userId) };
    case "saved_materials":
      return wallet ? { walletAddress: wallet } : null;
    case "collections":
      return { $or: [{ creatorId: String(userId) }, ...(wallet ? [{ walletAddress: wallet }] : [])] };
    case "progress":
      return { userId: String(userId) };
    case "webhooks":
      return { userId: String(userId) };
    case "webhook_deliveries":
      return { userId: String(userId) };
    case "outbox":
      return { $or: [
        { "payload.userId": String(userId) },
        ...(wallet ? [{ "payload.walletAddress": wallet }] : []),
      ]};
    case "data_export_requests":
      return { userId: String(userId) };
    default:
      return null;
  }
}
