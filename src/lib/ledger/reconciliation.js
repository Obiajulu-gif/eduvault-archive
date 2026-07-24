/**
 * Reconciliation between the journal, finalized Stellar activity, and the
 * operational purchase/refund collections.
 *
 * The job matches settlement-affecting ledger transactions to finalized
 * on-chain operations by source identity (network, txHash, opIndex), classifies
 * any divergence, and returns a set of replay candidates. Replay is safe because
 * posting is idempotent by the same identity, so re-posting a missing entry
 * cannot duplicate an existing one.
 */

import { ACCOUNTS } from "./accounts.js";
import { EVENT_TYPES, idempotencyKey } from "./journal.js";
import { asStroops } from "./money.js";

export const DISCREPANCY_TYPES = Object.freeze({
  MISSING_IN_LEDGER: "missing_in_ledger",
  MISSING_ON_CHAIN: "missing_on_chain",
  AMOUNT_MISMATCH: "amount_mismatch",
  DUPLICATE_IN_LEDGER: "duplicate_in_ledger",
  UNVERIFIABLE: "unverifiable",
});

function settlementDelta(tx) {
  // Net settlement movement of a transaction per asset (debit increases cash).
  const perAsset = new Map();
  for (const line of tx.lines) {
    if (line.account !== ACCOUNTS.SETTLEMENT) continue;
    const amount = asStroops(line.amount);
    const current = perAsset.get(line.assetKey) ?? 0n;
    perAsset.set(line.assetKey, current + (line.direction === "debit" ? amount : -amount));
  }
  return perAsset;
}

function opKey(op) {
  return `${op.network || "unknown"}:${op.txHash}:${op.opIndex == null ? "0" : String(op.opIndex)}`;
}

/**
 * @param {object} input
 * @param {Array} input.ledgerTransactions posted transactions
 * @param {Array} input.stellarOperations finalized operations:
 *        `{ network, txHash, opIndex, assetKey, amount, direction: "in"|"out" }`
 * @param {Array} [input.purchaseRecords] operational purchases:
 *        `{ id, network, txHash, opIndex, assetKey, amount, status, verified }`
 * @param {string} [input.eventType] business event to reconcile (default purchase)
 */
export function reconcile({
  ledgerTransactions,
  stellarOperations,
  purchaseRecords = [],
  eventType = EVENT_TYPES.PURCHASE,
}) {
  const discrepancies = [];
  const matched = [];

  // Index ledger transactions that carry a settlement effect, by source key.
  const ledgerByOp = new Map();
  for (const tx of ledgerTransactions) {
    if (!tx.source?.txHash) continue;
    const key = opKey(tx.source);
    const list = ledgerByOp.get(key) ?? [];
    list.push(tx);
    ledgerByOp.set(key, list);
  }

  const seenOps = new Set();

  for (const op of stellarOperations) {
    const key = opKey(op);
    seenOps.add(key);
    const txs = ledgerByOp.get(key) ?? [];
    if (txs.length === 0) {
      discrepancies.push({
        type: DISCREPANCY_TYPES.MISSING_IN_LEDGER,
        op,
        replay: {
          source: { network: op.network, txHash: op.txHash, opIndex: op.opIndex, eventType },
          idempotencyKey: idempotencyKey({
            network: op.network,
            txHash: op.txHash,
            opIndex: op.opIndex,
            eventType,
          }),
        },
      });
      continue;
    }
    if (txs.length > 1) {
      discrepancies.push({ type: DISCREPANCY_TYPES.DUPLICATE_IN_LEDGER, op, count: txs.length });
    }
    const expected = op.direction === "out" ? -asStroops(op.amount) : asStroops(op.amount);
    const actual = settlementDelta(txs[0]).get(op.assetKey) ?? 0n;
    if (actual !== expected) {
      discrepancies.push({
        type: DISCREPANCY_TYPES.AMOUNT_MISMATCH,
        op,
        expected: expected.toString(),
        actual: actual.toString(),
      });
    } else {
      matched.push({ op, transactionId: txs[0].id });
    }
  }

  // Ledger transactions with an on-chain identity that has no finalized op.
  for (const [key, txs] of ledgerByOp) {
    if (!seenOps.has(key)) {
      for (const tx of txs) {
        discrepancies.push({ type: DISCREPANCY_TYPES.MISSING_ON_CHAIN, transactionId: tx.id, source: tx.source });
      }
    }
  }

  // Operational purchases that claim completion but have no ledger posting.
  for (const record of purchaseRecords) {
    if (!record.txHash) {
      if (record.status === "confirmed" || record.status === "completed") {
        discrepancies.push({ type: DISCREPANCY_TYPES.UNVERIFIABLE, record });
      }
      continue;
    }
    const key = opKey(record);
    if (!ledgerByOp.has(key)) {
      discrepancies.push({
        type: DISCREPANCY_TYPES.MISSING_IN_LEDGER,
        record,
        replay: {
          source: { network: record.network, txHash: record.txHash, opIndex: record.opIndex, eventType },
          idempotencyKey: idempotencyKey({
            network: record.network,
            txHash: record.txHash,
            opIndex: record.opIndex,
            eventType,
          }),
        },
      });
    }
  }

  const replayable = discrepancies
    .filter((d) => d.type === DISCREPANCY_TYPES.MISSING_IN_LEDGER && d.replay)
    .map((d) => d.replay);

  return {
    matchedCount: matched.length,
    matched,
    discrepancies,
    replayable,
    balanced: discrepancies.length === 0,
  };
}
