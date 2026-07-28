import { COLLECTIONS } from "../backend/schemaContracts.js";

/**
 * Fork/reorg detection and bounded rewind (#469).
 *
 * The indexer checkpoints the sequence *and hash* of the last ledger whose
 * events it fully applied. Before trusting that checkpoint to resume from,
 * it re-fetches that same ledger from the network and compares hashes. A
 * mismatch means the chain reorganized at or before that ledger, so
 * everything the indexer applied from it onward may reflect a purchase,
 * material registration, or dispute that no longer exists on the canonical
 * chain.
 *
 * This only detects (and rewinds past) a reorg at the single most recently
 * checkpointed ledger — a *shallow* reorg, which is the common case for a
 * fast-finality network. It intentionally does not walk further back to
 * detect a reorg several ledgers deep, since that would require keeping a
 * full history of every checkpointed ledger's hash rather than just the
 * latest one. If that turns out to be needed in practice, extend
 * `checkpoints` (below) into an append-only per-ledger history instead of a
 * single latest-ledger snapshot, and walk backward from the tip until a
 * hash matches.
 */

/**
 * @param {import('mongodb').Db} db
 * @param {{ ledger: number, expectedHash: string, getLedgerHash: (sequence: number) => Promise<{ hash: string } | null> }} params
 * @returns {Promise<{ forked: boolean, canonicalHash?: string }>}
 */
export async function detectFork(db, { ledger, expectedHash, getLedgerHash }) {
  if (!ledger || !expectedHash || typeof getLedgerHash !== "function") return { forked: false };

  const canonical = await getLedgerHash(ledger);
  if (!canonical) {
    // Ledger has aged out of Horizon's retention window — too old to verify.
    // Not treated as a fork; the checkpoint is trusted as-is.
    return { forked: false };
  }

  if (canonical.hash === expectedHash) {
    return { forked: false };
  }

  return { forked: true, canonicalHash: canonical.hash };
}

/**
 * Roll back indexed state after a detected reorg at `divergenceLedger`:
 * marks materials/purchases/entitlements that were indexed from that ledger
 * onward as orphaned (rather than deleting them outright, so an operator can
 * audit exactly what was rolled back), invalidates any cached entitlement
 * for an orphaned purchase so access doesn't outlive the purchase it was
 * granted for, and rewinds the sync cursor + checkpoint so the next batch
 * re-applies events for the affected ledger range from a fresh chain state.
 *
 * @param {import('mongodb').Db} db
 * @param {{ source: string, divergenceLedger: number }} params
 * @returns {Promise<{ orphanedMaterials: number, orphanedPurchases: number }>}
 */
export async function rewindAfterFork(db, { source, divergenceLedger }) {
  const now = new Date();

  const orphanedMaterialsResult = await db.collection(COLLECTIONS.materials).updateMany(
    { chainLedger: { $gte: divergenceLedger }, syncStatus: { $ne: "orphaned" } },
    { $set: { syncStatus: "orphaned", orphanedAt: now, orphanedReason: "chain_reorg" } }
  );

  const orphanedPurchases = await db
    .collection(COLLECTIONS.purchases)
    .find({
      $or: [
        { indexedLedger: { $gte: divergenceLedger } },
        // Older records may not have `indexedLedger` recorded; fall back to
        // `updatedAt` proximity is unreliable, so those are left alone —
        // ledger-tagged records are the only ones we can safely identify.
      ],
    })
    .toArray();

  for (const purchase of orphanedPurchases) {
    await db.collection(COLLECTIONS.purchases).updateOne(
      { _id: purchase._id },
      { $set: { settlementState: "Orphaned", orphanedAt: now, updatedAt: now } }
    );
    if (purchase.buyerAddress && purchase.materialId) {
      const { invalidateEntitlement } = await import("../entitlement.js");
      await invalidateEntitlement(purchase.materialId, purchase.buyerAddress, "chain-reorg", {
        db,
        purchaseId: purchase.purchaseId,
        settlementState: "Orphaned",
      }).catch(() => {});
    }
  }

  // Rewind the cursor so the next batch starts fetching from before the
  // divergence point again. `cursor: null` re-fetches from the event
  // source's beginning rather than an arbitrary intermediate point, since
  // Soroban RPC cursors are opaque pagination tokens, not ledger sequences —
  // there is no cursor value we can compute for "resume at ledger N".
  // Operators with a large history should instead seed a fresh cursor via
  // `scripts/run-stellar-indexer.mjs recover`.
  await db.collection(COLLECTIONS.syncState).updateOne(
    { _id: `${source}:events` },
    {
      $set: {
        cursor: null,
        lastLedger: null,
        lastLedgerHash: null,
        lastForkRewindAt: now,
        lastForkDivergenceLedger: divergenceLedger,
        updatedAt: now,
      },
    }
  );

  return {
    orphanedMaterials: orphanedMaterialsResult.modifiedCount || 0,
    orphanedPurchases: orphanedPurchases.length,
  };
}
