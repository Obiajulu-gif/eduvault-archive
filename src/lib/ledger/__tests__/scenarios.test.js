import { describe, it, expect } from "vitest";

import { EVENT_TYPES, SETTLEMENT_STATES, reverseTransaction } from "../journal.js";
import { postPurchase, postRefund } from "../postingRules.js";
import { toStroops } from "../money.js";
import {
  creatorEarnings,
  creatorBalanceBreakdown,
  platformRevenue,
  settlementBalance,
  trialBalance,
} from "../balances.js";
import { InMemoryLedgerRepository } from "../repository/memory.js";

const USDC = "USDC:GISSUER";
const XLM = "native";

async function postPurchaseTx(repo, { txHash, gross, feeBps = 250, asset = USDC, creatorId = "c1", settlementState }) {
  const { lines, ruleVersion } = postPurchase({ gross, feeBps, assetKey: asset, creatorId });
  return repo.append({
    eventType: EVENT_TYPES.PURCHASE,
    source: { network: "public", txHash, opIndex: 0 },
    lines,
    ruleVersion,
    settlementState,
  });
}

describe("end-to-end ledger scenarios", () => {
  it("derives correct balances after a purchase and a partial refund", async () => {
    const repo = new InMemoryLedgerRepository();
    await postPurchaseTx(repo, { txHash: "buy1", gross: toStroops("100") });

    const refund = postRefund({
      amount: toStroops("40"),
      original: { net: toStroops("100"), proceeds: toStroops("97.5"), creatorId: "c1", assetKey: USDC },
    });
    await repo.append({
      eventType: EVENT_TYPES.REFUND,
      source: { network: "public", txHash: "ref1", opIndex: 0 },
      lines: refund.lines,
      ruleVersion: refund.ruleVersion,
    });

    const txs = await repo.all();
    expect(settlementBalance(txs, USDC)).toBe(toStroops("60"));
    // revenue + earnings always equals the cash still held
    expect(platformRevenue(txs, USDC) + creatorEarnings(txs, "c1", USDC)).toBe(toStroops("60"));
    for (const t of trialBalance(txs).values()) expect(t).toBe(0n);
  });

  it("is idempotent for duplicate and out-of-order postings", async () => {
    const repo = new InMemoryLedgerRepository();
    const a = await postPurchaseTx(repo, { txHash: "dup", gross: toStroops("100") });
    const b = await postPurchaseTx(repo, { txHash: "dup", gross: toStroops("100") });
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(await repo.all()).toHaveLength(1);
    // balances reflect a single purchase, not two
    expect(settlementBalance(await repo.all(), USDC)).toBe(toStroops("100"));
  });

  it("keeps per-asset balances independent across multiple assets", async () => {
    const repo = new InMemoryLedgerRepository();
    await postPurchaseTx(repo, { txHash: "u", gross: toStroops("100"), asset: USDC });
    await postPurchaseTx(repo, { txHash: "x", gross: toStroops("50"), asset: XLM });
    const txs = await repo.all();
    expect(settlementBalance(txs, USDC)).toBe(toStroops("100"));
    expect(settlementBalance(txs, XLM)).toBe(toStroops("50"));
    for (const t of trialBalance(txs).values()) expect(t).toBe(0n);
  });

  it("reverses a purchase back to zero and remains balanced", async () => {
    const repo = new InMemoryLedgerRepository();
    const { transaction } = await postPurchaseTx(repo, { txHash: "rev-me", gross: toStroops("100") });
    await repo.append(reverseTransaction(transaction, { reason: "chargeback" }));

    const txs = await repo.all();
    expect(settlementBalance(txs, USDC)).toBe(0n);
    expect(creatorEarnings(txs, "c1", USDC)).toBe(0n);
    expect(platformRevenue(txs, USDC)).toBe(0n);
    for (const t of trialBalance(txs).values()) expect(t).toBe(0n);
  });

  it("separates available (settled) from pending creator balances", async () => {
    const repo = new InMemoryLedgerRepository();
    await postPurchaseTx(repo, { txHash: "settled", gross: toStroops("100"), settlementState: SETTLEMENT_STATES.SETTLED });
    await postPurchaseTx(repo, { txHash: "pending", gross: toStroops("40"), settlementState: SETTLEMENT_STATES.PENDING });

    const breakdown = creatorBalanceBreakdown(await repo.all(), "c1", USDC);
    expect(breakdown.available).toBe(toStroops("97.5")); // from the settled 100-unit purchase
    expect(breakdown.pending).toBe(toStroops("39")); // 40 - 2.5% fee
    expect(breakdown.total).toBe(breakdown.available + breakdown.pending);
  });

  it("dedupes under concurrent posting of the same source event", async () => {
    const repo = new InMemoryLedgerRepository();
    const { lines, ruleVersion } = postPurchase({ gross: toStroops("100"), feeBps: 250, assetKey: USDC, creatorId: "c1" });
    const input = { eventType: EVENT_TYPES.PURCHASE, source: { network: "public", txHash: "race", opIndex: 0 }, lines, ruleVersion };
    const results = await Promise.all([repo.append(input), repo.append(input), repo.append(input)]);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    expect(await repo.all()).toHaveLength(1);
  });
});
