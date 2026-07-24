/**
 * Journal primitives: balanced transactions, source-event identity and
 * idempotency, immutability, and reversal/adjustment construction.
 *
 * A journal transaction is a set of debit/credit lines that must balance per
 * asset. Once created it is frozen; corrections are expressed as new reversal
 * or adjustment transactions, never by editing or deleting posted history.
 */

import { randomUUID } from "node:crypto";

import { asStroops, serializeStroops, assetKey as toAssetKey } from "./money.js";

export const DIRECTIONS = Object.freeze({ DEBIT: "debit", CREDIT: "credit" });

export const EVENT_TYPES = Object.freeze({
  PURCHASE: "purchase",
  REFUND: "refund",
  REVERSAL: "reversal",
  ADJUSTMENT: "adjustment",
});

export const SETTLEMENT_STATES = Object.freeze({
  PENDING: "pending",
  SETTLED: "settled",
});

export class LedgerError extends Error {
  constructor(message, code = "ledger_error") {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

function oppositeDirection(direction) {
  return direction === DIRECTIONS.DEBIT ? DIRECTIONS.CREDIT : DIRECTIONS.DEBIT;
}

/**
 * Build a normalized ledger line. Amounts are stored as integer stroop strings
 * so the line round-trips through JSON/Mongo without precision loss.
 */
export function makeLine({ account, subaccount = null, code = null, issuer = null, assetKey, direction, amount }) {
  if (!account) throw new LedgerError("Line requires an account", "invalid_line");
  if (direction !== DIRECTIONS.DEBIT && direction !== DIRECTIONS.CREDIT) {
    throw new LedgerError(`Invalid direction: ${direction}`, "invalid_line");
  }
  const stroops = asStroops(amount);
  if (stroops <= 0n) {
    throw new LedgerError("Line amount must be a positive integer stroop value", "invalid_line");
  }
  const key = assetKey ?? toAssetKey(code, issuer);
  return Object.freeze({
    account,
    subaccount: subaccount ? String(subaccount) : null,
    assetKey: key,
    direction,
    amount: serializeStroops(stroops),
  });
}

/**
 * Validate that lines balance (sum of debits equals sum of credits) for every
 * asset. Throws {@link LedgerError} on any imbalance or empty set.
 */
export function assertBalanced(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new LedgerError("A transaction must have at least one line", "empty_transaction");
  }
  const perAsset = new Map();
  for (const line of lines) {
    const entry = perAsset.get(line.assetKey) ?? { debit: 0n, credit: 0n };
    const amount = asStroops(line.amount);
    if (line.direction === DIRECTIONS.DEBIT) entry.debit += amount;
    else entry.credit += amount;
    perAsset.set(line.assetKey, entry);
  }
  for (const [key, { debit, credit }] of perAsset) {
    if (debit !== credit) {
      throw new LedgerError(
        `Transaction is unbalanced for asset ${key}: debit ${debit} != credit ${credit}`,
        "unbalanced",
      );
    }
    if (debit === 0n) {
      throw new LedgerError(`Transaction moves zero for asset ${key}`, "zero_transaction");
    }
  }
  return true;
}

/**
 * Deterministic idempotency key for a posting. Postings are unique by network,
 * settlement transaction hash, operation/event position, and business event
 * type, so a replay of the same source event maps to the same key.
 */
export function idempotencyKey({ network, txHash, opIndex, eventType, businessRef }) {
  if (!eventType) throw new LedgerError("idempotencyKey requires eventType", "invalid_source");
  if (txHash) {
    const position = opIndex == null ? "0" : String(opIndex);
    return `${network || "unknown"}:${txHash}:${position}:${eventType}`;
  }
  // Off-chain events (adjustments, unsettled records) need an explicit business
  // reference so they are still idempotent without a transaction hash.
  if (!businessRef) {
    throw new LedgerError(
      "Off-chain postings require an explicit businessRef for idempotency",
      "invalid_source",
    );
  }
  return `${network || "offchain"}:ref:${businessRef}:${eventType}`;
}

/**
 * Create an immutable, balanced journal transaction.
 *
 * `source` carries the identity used for idempotency and reconciliation:
 * `{ network, txHash, opIndex, businessRef }`. `ruleVersion` records which
 * posting-rule version produced the lines so historical interpretation is
 * preserved when policy changes.
 */
export function createTransaction({
  eventType,
  source = {},
  lines,
  ruleVersion,
  occurredAt,
  settlementState = SETTLEMENT_STATES.SETTLED,
  metadata = {},
}) {
  if (!Object.values(EVENT_TYPES).includes(eventType)) {
    throw new LedgerError(`Unknown event type: ${eventType}`, "invalid_event");
  }
  assertBalanced(lines);
  const key = idempotencyKey({ ...source, eventType });
  const occurred = occurredAt ? new Date(occurredAt) : new Date();

  return Object.freeze({
    id: randomUUID(),
    eventType,
    idempotencyKey: key,
    source: Object.freeze({
      network: source.network ?? null,
      txHash: source.txHash ?? null,
      opIndex: source.opIndex ?? null,
      businessRef: source.businessRef ?? null,
    }),
    ruleVersion: ruleVersion ?? null,
    settlementState,
    lines: Object.freeze(lines.map((line) => Object.freeze({ ...line }))),
    occurredAt: occurred.toISOString(),
    metadata: Object.freeze({ ...metadata }),
  });
}

/**
 * Build a reversal transaction that exactly negates a posted transaction by
 * swapping every line's direction. The original is never mutated.
 */
export function reverseTransaction(original, { reason = null, occurredAt } = {}) {
  if (!original?.id) throw new LedgerError("Cannot reverse a transaction without an id", "invalid_reversal");
  const reversedLines = original.lines.map((line) =>
    Object.freeze({ ...line, direction: oppositeDirection(line.direction) }),
  );
  assertBalanced(reversedLines);
  const occurred = occurredAt ? new Date(occurredAt) : new Date();

  return Object.freeze({
    id: randomUUID(),
    eventType: EVENT_TYPES.REVERSAL,
    idempotencyKey: `reversal:${original.idempotencyKey}`,
    source: Object.freeze({ ...original.source }),
    ruleVersion: original.ruleVersion,
    settlementState: original.settlementState,
    reverses: original.id,
    lines: Object.freeze(reversedLines),
    occurredAt: occurred.toISOString(),
    metadata: Object.freeze({ reason }),
  });
}

/**
 * Build a manual balanced adjustment. Requires an explicit `businessRef` so it
 * is idempotent and auditable.
 */
export function createAdjustment({ businessRef, network = "offchain", lines, occurredAt, reason = null, ruleVersion }) {
  if (!businessRef) throw new LedgerError("Adjustments require a businessRef", "invalid_adjustment");
  return createTransaction({
    eventType: EVENT_TYPES.ADJUSTMENT,
    source: { network, businessRef },
    lines,
    ruleVersion,
    occurredAt,
    metadata: { reason, adjustment: true },
  });
}
