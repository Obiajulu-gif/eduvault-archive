/**
 * Payment reconciliation for asynchronous Stellar payment confirmations — Issue #418.
 *
 * Stellar/Soroban does not push webhooks from the network. The synchronous
 * checkout path (POST /api/purchase) only marks a purchase "confirmed" when the
 * client hands back a transaction hash / signed XDR in the same request. If that
 * request fails, times out, or the user's session ends before the transaction
 * lands on-chain, the purchase is left in a "pending" state and access is never
 * granted even though the payment eventually confirms.
 *
 * This module implements the decoupled, asynchronous confirmation path: given a
 * way to look up a transaction's on-chain status, it scans pending purchases,
 * confirms the ones whose payment has landed, and grants access using the same
 * entitlement mechanism as the synchronous path. It is invoked by a polling
 * scheduler (see /api/webhooks/stellar) — there is no inbound network payload.
 *
 * Every dependency (DB, transaction lookup, entitlement grant, side-effects,
 * logger) is injected so the logic can be unit-tested without any network or
 * database access.
 */

// Purchase statuses that are still awaiting on-chain confirmation.
export const PENDING_RECONCILE_STATUSES = ["pending", "processing", "indexing", "requires_payment"];

const DEFAULT_LIMIT = 50;
const noopLogger = { info() {}, warn() {}, error() {} };

/**
 * Reconcile pending purchases against the Stellar network.
 *
 * @param {object}   deps
 * @param {object}   deps.db                 - MongoDB database instance.
 * @param {(hash: string) => Promise<'confirmed'|'failed'|'pending'|'not_found'>} deps.getTransactionStatus
 *                                             Resolves a transaction hash to its on-chain status.
 * @param {(materialId: string, buyerAddress: string, meta: object) => Promise<any>} deps.grantEntitlement
 *                                             Grants access for a confirmed purchase.
 * @param {(purchase: object) => Promise<void>} [deps.onConfirmed]
 *                                             Optional side-effect hook (receipts, outbound webhooks).
 * @param {number}   [deps.limit]             - Max purchases to process per run.
 * @param {object}   [deps.logger]            - Structured logger; defaults to a no-op.
 * @returns {Promise<{checked:number,confirmed:number,failed:number,stillPending:number,errors:number}>}
 */
export async function reconcilePendingPurchases({
  db,
  getTransactionStatus,
  grantEntitlement,
  onConfirmed,
  limit = DEFAULT_LIMIT,
  logger = noopLogger,
} = {}) {
  if (!db) throw new Error("reconcilePendingPurchases: db is required");
  if (typeof getTransactionStatus !== "function") {
    throw new Error("reconcilePendingPurchases: getTransactionStatus is required");
  }
  if (typeof grantEntitlement !== "function") {
    throw new Error("reconcilePendingPurchases: grantEntitlement is required");
  }

  const summary = { checked: 0, confirmed: 0, failed: 0, stillPending: 0, errors: 0 };

  const pending = await db
    .collection("purchases")
    .find({
      status: { $in: PENDING_RECONCILE_STATUSES },
      transactionHash: { $nin: [null, ""] },
    })
    .limit(limit)
    .toArray();

  for (const purchase of pending) {
    summary.checked += 1;
    try {
      const status = await getTransactionStatus(purchase.transactionHash);

      if (status === "confirmed") {
        const now = new Date();
        await db.collection("purchases").updateOne(
          { _id: purchase._id },
          {
            $set: {
              status: "confirmed",
              confirmedAt: now,
              purchasedAt: purchase.purchasedAt || now,
              updatedAt: now,
            },
          }
        );

        await grantEntitlement(purchase.materialId, purchase.buyerAddress, {
          purchaseId: String(purchase._id),
          transactionHash: purchase.transactionHash,
          amount: purchase.amount,
          asset: purchase.asset,
        });

        if (typeof onConfirmed === "function") {
          await onConfirmed({ ...purchase, status: "confirmed", confirmedAt: now });
        }

        summary.confirmed += 1;
        logger.info(
          `Reconciled purchase ${purchase._id} for material ${purchase.materialId} — payment confirmed on-chain`
        );
      } else if (status === "failed") {
        const now = new Date();
        await db.collection("purchases").updateOne(
          { _id: purchase._id },
          { $set: { status: "failed", updatedAt: now } }
        );
        summary.failed += 1;
        logger.warn(
          `Purchase ${purchase._id} marked failed — transaction ${purchase.transactionHash} did not succeed on-chain`
        );
      } else {
        // 'pending' | 'not_found' — leave untouched for the next polling run.
        summary.stillPending += 1;
      }
    } catch (err) {
      summary.errors += 1;
      logger.error(
        `Payment reconciliation failed for purchase ${purchase._id}: ${err?.message || err}`
      );
    }
  }

  return summary;
}
