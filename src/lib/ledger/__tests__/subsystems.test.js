import { describe, it, expect } from "vitest";

import { createTransaction, EVENT_TYPES } from "../journal.js";
import { postPurchase } from "../postingRules.js";
import { toStroops } from "../money.js";
import { reconcile, DISCREPANCY_TYPES } from "../reconciliation.js";
import { runBackfillBatch, ROW_OUTCOMES } from "../backfill.js";
import { closePeriod, detectLateEvents, verifySnapshot } from "../period.js";
import { InMemoryLedgerRepository } from "../repository/memory.js";

const ASSET = "USDC:GISSUER";
const NET = toStroops("100"); // settlement amount for a 100-unit purchase, fee 2.5%

function purchase(txHash, opIndex = 0, occurredAt) {
  const { lines, ruleVersion } = postPurchase({ gross: NET, feeBps: 250, assetKey: ASSET, creatorId: "c1" });
  return createTransaction({
    eventType: EVENT_TYPES.PURCHASE,
    source: { network: "public", txHash, opIndex },
    lines,
    ruleVersion,
    occurredAt,
  });
}

describe("reconciliation", () => {
  it("matches settlement postings to finalized on-chain operations", () => {
    const tx = purchase("h1");
    const report = reconcile({
      ledgerTransactions: [tx],
      stellarOperations: [{ network: "public", txHash: "h1", opIndex: 0, assetKey: ASSET, amount: NET.toString(), direction: "in" }],
    });
    expect(report.balanced).toBe(true);
    expect(report.matchedCount).toBe(1);
  });

  it("flags on-chain operations missing from the ledger and offers a replay", () => {
    const report = reconcile({
      ledgerTransactions: [],
      stellarOperations: [{ network: "public", txHash: "h2", opIndex: 0, assetKey: ASSET, amount: NET.toString(), direction: "in" }],
    });
    const missing = report.discrepancies.find((d) => d.type === DISCREPANCY_TYPES.MISSING_IN_LEDGER);
    expect(missing).toBeTruthy();
    expect(report.replayable).toHaveLength(1);
    expect(report.replayable[0].idempotencyKey).toBe("public:h2:0:purchase");
  });

  it("flags ledger postings with no finalized on-chain operation", () => {
    const report = reconcile({ ledgerTransactions: [purchase("h3")], stellarOperations: [] });
    expect(report.discrepancies.some((d) => d.type === DISCREPANCY_TYPES.MISSING_ON_CHAIN)).toBe(true);
  });

  it("detects amount mismatches", () => {
    const report = reconcile({
      ledgerTransactions: [purchase("h4")],
      stellarOperations: [{ network: "public", txHash: "h4", opIndex: 0, assetKey: ASSET, amount: "1", direction: "in" }],
    });
    expect(report.discrepancies.some((d) => d.type === DISCREPANCY_TYPES.AMOUNT_MISMATCH)).toBe(true);
  });

  it("classifies a confirmed purchase with no settlement hash as unverifiable", () => {
    const report = reconcile({
      ledgerTransactions: [],
      stellarOperations: [],
      purchaseRecords: [{ id: "p1", status: "confirmed", txHash: null }],
    });
    expect(report.discrepancies.some((d) => d.type === DISCREPANCY_TYPES.UNVERIFIABLE)).toBe(true);
  });

  it("supports safe idempotent replay of missing postings", async () => {
    const report = reconcile({
      ledgerTransactions: [],
      stellarOperations: [{ network: "public", txHash: "h5", opIndex: 0, assetKey: ASSET, amount: NET.toString(), direction: "in" }],
    });
    const repo = new InMemoryLedgerRepository();
    const { lines, ruleVersion } = postPurchase({ gross: NET, feeBps: 250, assetKey: ASSET, creatorId: "c1" });
    const source = report.replayable[0].source;
    const first = await repo.append({ eventType: EVENT_TYPES.PURCHASE, source, lines, ruleVersion });
    const second = await repo.append({ eventType: EVENT_TYPES.PURCHASE, source, lines, ruleVersion });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect((await repo.all())).toHaveLength(1);
  });
});

describe("backfill", () => {
  const rows = [
    { sortKey: 1, id: "a", amount: NET, assetKey: ASSET, creatorId: "c1", txHash: "t1" },
    { sortKey: 2, id: "b", amount: NET, assetKey: ASSET, creatorId: "c1", txHash: "t2" },
    { sortKey: 3, id: "c", amount: NET, assetKey: ASSET, creatorId: "c1" }, // ambiguous: no txHash
    { sortKey: 4, id: "d", amount: NET, assetKey: ASSET, creatorId: "c1", txHash: "t4" },
  ];

  it("dry-run reports without writing", async () => {
    const repo = new InMemoryLedgerRepository();
    const result = await runBackfillBatch({ rows, repository: repo, dryRun: true, feeBps: 250, batchSize: 10 });
    expect(result.posted).toBe(3);
    expect(result.ambiguous).toBe(1);
    expect((await repo.all())).toHaveLength(0);
  });

  it("checkpoints and restarts without reprocessing", async () => {
    const repo = new InMemoryLedgerRepository();
    const first = await runBackfillBatch({ rows, repository: repo, feeBps: 250, batchSize: 2 });
    expect(first.posted).toBe(2);
    expect(first.done).toBe(false);

    const second = await runBackfillBatch({
      rows,
      repository: repo,
      feeBps: 250,
      batchSize: 2,
      checkpoint: first.nextCheckpoint,
    });
    expect(second.done).toBe(true);
    expect(second.ambiguous).toBe(1); // row 3
    expect(second.posted).toBe(1); // row 4
    expect((await repo.all())).toHaveLength(3);
  });

  it("is idempotent across a re-run of the same batch", async () => {
    const repo = new InMemoryLedgerRepository();
    await runBackfillBatch({ rows, repository: repo, feeBps: 250, batchSize: 10 });
    const rerun = await runBackfillBatch({ rows, repository: repo, feeBps: 250, batchSize: 10 });
    expect(rerun.skippedDuplicate).toBe(3);
    expect(rerun.entries.some((e) => e.outcome === ROW_OUTCOMES.AMBIGUOUS)).toBe(true);
    expect((await repo.all())).toHaveLength(3);
  });
});

describe("period close", () => {
  it("produces a reproducible snapshot digest", () => {
    const txs = [purchase("h1", 0, "2026-01-01T00:00:00Z"), purchase("h2", 0, "2026-01-15T00:00:00Z")];
    const snap = closePeriod({ transactions: txs, asOf: "2026-01-31T23:59:59Z", closedAt: "2026-02-01T00:00:00Z" });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(verifySnapshot(snap, txs)).toBe(true);
    // recomputing yields the identical digest
    const again = closePeriod({ transactions: txs, asOf: "2026-01-31T23:59:59Z", closedAt: "2026-02-01T00:00:00Z" });
    expect(again.digest).toBe(snap.digest);
  });

  it("detects a late event inside a closed period without changing the snapshot", () => {
    const onTime = purchase("h1", 0, "2026-01-10T00:00:00Z");
    const snap = closePeriod({ transactions: [onTime], asOf: "2026-01-31T23:59:59Z", closedAt: "2026-02-01T00:00:00Z" });

    const late = { ...purchase("h2", 0, "2026-01-20T00:00:00Z"), postedAt: "2026-02-05T00:00:00Z" };
    const lateEvents = detectLateEvents(snap, [onTime, late]);
    expect(lateEvents).toHaveLength(1);
    expect(lateEvents[0].source.txHash).toBe("h2");
    // the stored snapshot is unchanged (still verifies against its original inputs)
    expect(verifySnapshot(snap, [onTime])).toBe(true);
  });
});

describe("repository is append-only", () => {
  it("exposes no update or delete of posted history", () => {
    const repo = new InMemoryLedgerRepository();
    expect(typeof repo.append).toBe("function");
    expect(repo.update).toBeUndefined();
    expect(repo.delete).toBeUndefined();
    expect(repo.remove).toBeUndefined();
  });
});
