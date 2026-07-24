/**
 * Integration seam between the application and the ledger.
 *
 * These helpers take a Mongo `Db` explicitly (dependency injection) instead of
 * importing the connection module, so the ledger stays testable and free of
 * import-time side effects. Call them from the purchase and refund flows to
 * record balanced, idempotent postings alongside the existing operational writes
 * (ideally inside the same Mongo transaction/session).
 *
 * Example (inside the purchase route, after settlement is verified):
 *
 *   import { recordPurchase } from "@/lib/ledger/service";
 *   await recordPurchase(db, {
 *     network, txHash, opIndex: 0, gross: amount, feeBps,
 *     assetKey, creatorId, occurredAt: purchasedAt,
 *   });
 *
 * Posting is idempotent by (network, txHash, opIndex, eventType), so it is safe
 * to call on retries and reprocessing.
 */

import { MongoLedgerRepository } from "./repository/mongo.js";
import { postPurchase, postRefund, postRefundSettlement } from "./postingRules.js";
import { EVENT_TYPES, reverseTransaction } from "./journal.js";

export function ledgerRepository(db) {
  return new MongoLedgerRepository(db);
}

/** Create the ledger indexes. Run once during migration/setup. */
export async function ensureLedgerIndexes(db) {
  await new MongoLedgerRepository(db).ensureIndexes();
}

export async function recordPurchase(
  db,
  { network, txHash, opIndex = 0, gross, discount = 0, feeBps, assetKey, creatorId, occurredAt, settlementState, ruleVersion },
) {
  const repo = new MongoLedgerRepository(db);
  const built = postPurchase({ gross, discount, feeBps, assetKey, creatorId }, ruleVersion);
  return repo.append({
    eventType: EVENT_TYPES.PURCHASE,
    source: { network, txHash, opIndex },
    lines: built.lines,
    ruleVersion: built.ruleVersion,
    occurredAt,
    settlementState,
    metadata: { creatorId },
  });
}

export async function recordRefund(
  db,
  { network, txHash, opIndex = 0, amount, original, occurredAt, settlementState },
) {
  const repo = new MongoLedgerRepository(db);
  const built = postRefund({ amount, original, settlementState });
  return repo.append({
    eventType: EVENT_TYPES.REFUND,
    source: { network, txHash, opIndex },
    lines: built.lines,
    ruleVersion: built.ruleVersion,
    occurredAt,
    settlementState,
  });
}

export async function recordRefundSettlement(db, { network, txHash, opIndex = 0, amount, assetKey, occurredAt }) {
  const repo = new MongoLedgerRepository(db);
  const built = postRefundSettlement({ amount, assetKey });
  return repo.append({
    eventType: EVENT_TYPES.REFUND,
    source: { network, txHash, opIndex, businessRef: `settle:${txHash}:${opIndex}` },
    lines: built.lines,
    ruleVersion: built.ruleVersion,
    occurredAt,
  });
}

/** Record a reversal of an existing posted transaction (e.g. a chargeback). */
export async function recordReversal(db, transaction, { reason } = {}) {
  const repo = new MongoLedgerRepository(db);
  return repo.append(reverseTransaction(transaction, { reason }));
}
