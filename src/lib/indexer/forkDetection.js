import { COLLECTIONS } from "../backend/schemaContracts.js";

/**
 * How many recent per-ledger checkpoints the sync state retains for deep
 * reorg detection. Configurable via `FORK_DETECTION_DEPTH`; deliberately
 * small — unbounded backward walking (and unbounded history retention) on
 * every batch would be its own performance problem, mirroring the
 * resource-limit reasoning used for `MAX_MAINTENANCE_BATCH` elsewhere.
 */
export const MAX_CHECKPOINTS = Number(process.env.FORK_DETECTION_DEPTH || 8);

/**
 * Fork/reorg detection and bounded rewind (#469, extended for deep reorgs).
 *
 * The indexer checkpoints the sequence *and hash* of the last ledger whose
 * events it fully applied. Before trusting that checkpoint to resume from,
 * it re-fetches that same ledger from the network and compares hashes. A
 * mismatch means the chain reorganized at or before that ledger, so
 * everything the indexer applied from it onward may reflect a purchase,
 * material registration, or dispute that no longer exists on the canonical
 * chain.
 *
 * Detection depth: the sync state retains a bounded history of the last
 * `MAX_CHECKPOINTS` checkpoint hashes (`checkpoints` on the `sync_state`
 * document, alongside the legacy `lastLedger`/`lastLedgerHash` fields).
 * `detectFork` walks that history backward from the most recent checkpoint
 * until it finds a ledger whose hash still matches the canonical chain, so a
 * reorg several checkpoints deep (e.g. the indexer was down across a
 * checkpoint interval) is detected and rewound past rather than being
 * silently reported as "not forked" because only the tip was compared.
 */

/**
 * Normalize a checkpoint history into a bounded, ascending, deduplicated
 * list. Invalid entries are dropped; for a given ledger the newest recorded
 * hash wins.
 *
 * @param {Array<{ ledger: number, hash: string }>} checkpoints
 * @returns {Array<{ ledger: number, hash: string }>}
 */
export function dedupeCheckpoints(checkpoints) {
  const byLedger = new Map();
  for (const cp of checkpoints || []) {
    if (cp && Number.isFinite(cp.ledger) && typeof cp.hash === "string") {
      byLedger.set(cp.ledger, cp);
    }
  }
  return [...byLedger.values()].sort((a, b) => a.ledger - b.ledger);
}

/**
 * @param {import('mongodb').Db} db
 * @param {{ ledger?: number, expectedHash?: string, checkpoints?: Array<{ ledger: number, hash: string }>, getLedgerHash: (sequence: number) => Promise<{ hash: string } | null> }} params
 * @returns {Promise<{ forked: boolean, divergenceLedger?: number, canonicalHash?: string | null }>}
 */
export async function detectFork(db, { ledger, expectedHash, checkpoints, getLedgerHash }) {
  if (typeof getLedgerHash !== "function") return { forked: false };

  // Normalise to an ascending checkpoint history. Backwards compatibility:
  // callers still passing a single (ledger, expectedHash) pair are treated as
  // a one-entry history.
  let history;
  if (Array.isArray(checkpoints) && checkpoints.length > 0) {
    history = dedupeCheckpoints(checkpoints);
  } else if (ledger && expectedHash) {
    history = [{ ledger, hash: expectedHash }];
  } else {
    return { forked: false };
  }

  // Walk from the most recent checkpoint backwards until a recorded hash
  // still matches canonical. The first match means the chain is intact up to
  // and including that ledger, so the true divergence point is the ledger
  // right after it (everything from there on may have been rewritten). A
  // fork is only declared when an actual hash mismatch is observed — a
  // checkpoint that aged out of retention is no evidence either way.
  let sawMismatch = false;
  let lastMismatchCanonicalHash = null;
  let lastMatchIndex = -1;

  for (let i = history.length - 1; i >= 0; i--) {
    const checkpoint = history[i];
    const canonical = await getLedgerHash(checkpoint.ledger);
    if (!canonical) {
      // Ledger has aged out of Horizon's retention window — too old to
      // verify. Not evidence of a fork by itself; keep walking older.
      continue;
    }

    if (canonical.hash === checkpoint.hash) {
      lastMatchIndex = i;
      break;
    }

    sawMismatch = true;
    lastMismatchCanonicalHash = canonical.hash;
  }

  if (!sawMismatch) {
    // Either the most recent verifiable checkpoint matches (no fork) or
    // nothing could be verified (aged out) — trust the recorded state.
    return { forked: false };
  }

  if (lastMatchIndex !== -1) {
    // Chain is intact up to the matched checkpoint; the divergence is at the
    // ledger right after it.
    return {
      forked: true,
      divergenceLedger: history[lastMatchIndex].ledger + 1,
      canonicalHash: lastMismatchCanonicalHash,
    };
  }

  // No retained checkpoint matches canonical: the reorg reaches back at or
  // before the oldest retained checkpoint, so rewind everything we have.
  return {
    forked: true,
    divergenceLedger: history[0].ledger,
    canonicalHash: lastMismatchCanonicalHash,
  };
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
  const stateId = `${source}:events`;

  // Keep checkpoints strictly below the divergence point (their hashes were
  // verified against the canonical chain during detection); drop everything
  // from the divergence point onward so the next batch re-verifies from a
  // clean slate after the rewind.
  const state = await db.collection(COLLECTIONS.syncState).findOne({ _id: stateId });
  const retainedCheckpoints = (state?.checkpoints || []).filter(
    (cp) => cp && cp.ledger < divergenceLedger,
  );

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
    { _id: stateId },
    {
      $set: {
        cursor: null,
        lastLedger: null,
        lastLedgerHash: null,
        checkpoints: retainedCheckpoints,
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
