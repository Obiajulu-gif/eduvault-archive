/**
 * Checkpointed backfill of legacy purchases/refunds into the ledger.
 *
 * Legacy rows are processed in deterministic order, in batches, from a stored
 * checkpoint so a crashed run resumes without reprocessing. A dry run reports
 * exactly what would be posted without writing. Rows that cannot be posted
 * safely (missing amount, asset, creator, or unverifiable settlement) are
 * flagged as ambiguous and never guessed.
 */

import { EVENT_TYPES } from "./journal.js";
import { postPurchase } from "./postingRules.js";

export const ROW_OUTCOMES = Object.freeze({
  POSTED: "posted",
  SKIPPED_DUPLICATE: "skipped_duplicate",
  AMBIGUOUS: "ambiguous",
});

function classifyRow(row) {
  const reasons = [];
  if (row.amount == null) reasons.push("missing_amount");
  if (!row.assetKey && !row.asset) reasons.push("missing_asset");
  if (!row.creatorId) reasons.push("missing_creator");
  if (!row.txHash) reasons.push("unverifiable_no_txhash");
  return reasons;
}

/**
 * Run (or dry-run) a backfill batch.
 *
 * @param {object} input
 * @param {Array} input.rows legacy purchase rows sorted by `sortKey`
 * @param {object} input.repository ledger repository (append/getByKey)
 * @param {(row:object)=>object} [input.buildPosting] override posting builder
 * @param {number} [input.batchSize]
 * @param {string|number|null} [input.checkpoint] last processed sortKey
 * @param {boolean} [input.dryRun]
 * @param {string} [input.network]
 */
export async function runBackfillBatch({
  rows,
  repository,
  buildPosting,
  batchSize = 100,
  checkpoint = null,
  dryRun = false,
  network = "public",
  feeBps = 0,
  ruleVersion,
}) {
  const ordered = [...rows].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const start = checkpoint == null ? 0 : ordered.findIndex((r) => r.sortKey === checkpoint) + 1;
  const batch = ordered.slice(start, start + batchSize);

  const report = { posted: 0, skippedDuplicate: 0, ambiguous: 0, ambiguousRows: [], entries: [] };
  let lastKey = checkpoint;

  for (const row of batch) {
    lastKey = row.sortKey;
    const reasons = classifyRow(row);
    if (reasons.length > 0) {
      report.ambiguous += 1;
      report.ambiguousRows.push({ sortKey: row.sortKey, id: row.id, reasons });
      report.entries.push({ sortKey: row.sortKey, outcome: ROW_OUTCOMES.AMBIGUOUS, reasons });
      continue;
    }

    const built = buildPosting
      ? buildPosting(row)
      : postPurchase(
          {
            gross: row.amount,
            discount: row.discount ?? 0,
            feeBps,
            assetKey: row.assetKey ?? row.asset,
            creatorId: row.creatorId,
          },
          ruleVersion,
        );

    const source = {
      network: row.network ?? network,
      txHash: row.txHash,
      opIndex: row.opIndex ?? 0,
      eventType: EVENT_TYPES.PURCHASE,
    };

    if (dryRun) {
      report.posted += 1;
      report.entries.push({ sortKey: row.sortKey, outcome: ROW_OUTCOMES.POSTED, dryRun: true });
      continue;
    }

    const result = await repository.append({
      eventType: EVENT_TYPES.PURCHASE,
      source,
      lines: built.lines,
      ruleVersion: built.ruleVersion,
      occurredAt: row.occurredAt,
      settlementState: row.settlementState ?? "settled",
      metadata: { backfilledFrom: row.id ?? row.sortKey },
    });

    if (result.deduplicated) {
      report.skippedDuplicate += 1;
      report.entries.push({ sortKey: row.sortKey, outcome: ROW_OUTCOMES.SKIPPED_DUPLICATE });
    } else {
      report.posted += 1;
      report.entries.push({ sortKey: row.sortKey, outcome: ROW_OUTCOMES.POSTED, transactionId: result.transaction.id });
    }
  }

  const nextIndex = start + batch.length;
  return {
    ...report,
    processed: batch.length,
    nextCheckpoint: lastKey,
    done: nextIndex >= ordered.length,
  };
}
