/**
 * Accounting periods and reproducible statement snapshots.
 *
 * A period close snapshots balances as of a boundary. The snapshot is derived
 * purely from the immutable log, so recomputing it from the same transactions
 * always produces the same numbers (and the same digest). Once a period is
 * closed, a late event whose business time falls inside the closed period does
 * not silently change the snapshot: it is surfaced as requiring a visible
 * adjustment in a later, open period.
 */

import { createHash } from "node:crypto";

import { aggregate, accountBalance } from "./balances.js";
import { isNormalDebit } from "./accounts.js";

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compute an immutable period-close snapshot for transactions whose business
 * time (`occurredAt`) is at or before `asOf`. `closedAt` records when the close
 * ran and is used to detect late arrivals.
 */
export function closePeriod({ transactions, asOf, closedAt = new Date() }) {
  const boundary = new Date(asOf);
  const closedAtIso = new Date(closedAt).toISOString();
  const totals = aggregate(transactions, { asOf: boundary });

  const balances = [];
  for (const entry of totals.values()) {
    const balance = accountBalance(totals, entry.account, entry.subaccount, entry.assetKey);
    if (balance === 0n) continue;
    balances.push({
      account: entry.account,
      subaccount: entry.subaccount,
      assetKey: entry.assetKey,
      balance: balance.toString(),
      normalSide: isNormalDebit(entry.account) ? "debit" : "credit",
    });
  }
  balances.sort((a, b) =>
    stableStringify([a.account, a.subaccount, a.assetKey]) <
    stableStringify([b.account, b.subaccount, b.assetKey])
      ? -1
      : 1,
  );

  const includedIds = transactions
    .filter((tx) => new Date(tx.occurredAt).getTime() <= boundary.getTime())
    .map((tx) => tx.id)
    .sort();

  const body = { asOf: boundary.toISOString(), balances, transactionCount: includedIds.length };
  const digest = createHash("sha256").update(stableStringify(body)).digest("hex");

  return Object.freeze({ ...body, closedAt: closedAtIso, digest, includedIds: Object.freeze(includedIds) });
}

/**
 * Given a closed snapshot and the full current transaction set, return the
 * transactions that arrived after the close but whose business time falls inside
 * the closed period. These require a visible adjustment rather than a silent
 * restatement.
 */
export function detectLateEvents(snapshot, transactions) {
  const boundary = new Date(snapshot.asOf).getTime();
  const closedAt = new Date(snapshot.closedAt).getTime();
  const included = new Set(snapshot.includedIds);
  return transactions.filter((tx) => {
    if (included.has(tx.id)) return false;
    const occurred = new Date(tx.occurredAt).getTime();
    const posted = tx.postedAt ? new Date(tx.postedAt).getTime() : closedAt + 1;
    return occurred <= boundary && posted > closedAt;
  });
}

/** True when recomputing the snapshot from `transactions` reproduces its digest. */
export function verifySnapshot(snapshot, transactions) {
  const recomputed = closePeriod({ transactions, asOf: snapshot.asOf, closedAt: snapshot.closedAt });
  return recomputed.digest === snapshot.digest;
}
