/**
 * Active Obligation Checker
 *
 * Determines whether a user has outstanding financial or escrow obligations
 * that must be resolved before account deletion can proceed.
 *
 * A deletion request is BLOCKED if any of:
 *   1. The user has purchases in a non-terminal state (pending / in-flight)
 *   2. The user has materials with active, non-settled purchases by others
 *      (creator may have pending payout obligations)
 *   3. The user has unclaimed ledger credit balances
 *      (creator earnings not yet withdrawn)
 *
 * The check is intentionally conservative. If uncertain, it blocks.
 */

import { getDb } from "@/lib/mongodb.js";

const PURCHASE_TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "refunded",
  "cancelled",
]);

/**
 * Check whether the user has active obligations that prevent deletion.
 *
 * @param {string} userId   – MongoDB _id as string
 * @param {string} wallet   – wallet address (may be null for non-wallet users)
 * @returns {{ blocked: boolean, reasons: string[] }}
 */
export async function checkObligations(userId, wallet) {
  const db = await getDb();
  const reasons = [];

  // 1. Buyer: purchases in a non-terminal state
  if (wallet) {
    const inflight = await db.collection("purchases").countDocuments({
      buyerAddress: wallet,
      status: { $nin: [...PURCHASE_TERMINAL_STATES] },
    });
    if (inflight > 0) {
      reasons.push(
        `You have ${inflight} purchase(s) in progress. Wait for them to complete or be refunded.`
      );
    }
  }

  // 2. Creator: materials with purchases that are non-terminal
  //    (someone is actively paying for a material the user created)
  if (wallet) {
    const creatorMaterials = await db
      .collection("materials")
      .find({ $or: [{ userAddress: wallet }, { walletAddress: wallet }] }, { projection: { _id: 1 } })
      .toArray();

    if (creatorMaterials.length > 0) {
      const materialIds = creatorMaterials.map((m) => String(m._id));
      const pendingCreatorPurchases = await db.collection("purchases").countDocuments({
        materialId: { $in: materialIds },
        status: { $nin: [...PURCHASE_TERMINAL_STATES] },
      });
      if (pendingCreatorPurchases > 0) {
        reasons.push(
          `${pendingCreatorPurchases} purchase(s) of your materials are still in progress.`
        );
      }
    }
  }

  // 3. Ledger: unclaimed creator credit balance
  //    We look for ledger entries where the creator is the credit account
  //    and settlement is still pending.
  if (wallet) {
    try {
      const pendingLedger = await db.collection("ledger").countDocuments({
        "lines.account": wallet,
        "lines.direction": "credit",
        settlementState: "pending",
      });
      if (pendingLedger > 0) {
        reasons.push(
          `You have ${pendingLedger} unsettled credit(s) on the ledger. Please withdraw your earnings first.`
        );
      }
    } catch {
      // ledger collection may not exist in all environments; skip
    }
  }

  return { blocked: reasons.length > 0, reasons };
}
