import { describe, it, expect } from "vitest";

import {
  toStroops,
  fromStroops,
  assetKey,
  mulDivFloor,
  MoneyError,
  NATIVE_ASSET_KEY,
} from "../money.js";
import {
  makeLine,
  assertBalanced,
  idempotencyKey,
  createTransaction,
  reverseTransaction,
  createAdjustment,
  DIRECTIONS,
  EVENT_TYPES,
  LedgerError,
} from "../journal.js";
import {
  postPurchase,
  postRefund,
  PURCHASE_RULE_VERSIONS,
} from "../postingRules.js";
import {
  creatorEarnings,
  platformRevenue,
  settlementBalance,
  trialBalance,
} from "../balances.js";
import { ACCOUNTS } from "../accounts.js";

const ASSET = "USDC:GISSUER";

function purchaseTx(overrides = {}) {
  const { lines, ruleVersion, breakdown } = postPurchase({
    gross: toStroops("100"),
    discount: 0,
    feeBps: 250,
    assetKey: ASSET,
    creatorId: "creator-1",
    ...overrides.input,
  });
  return {
    tx: createTransaction({
      eventType: EVENT_TYPES.PURCHASE,
      source: { network: "public", txHash: overrides.txHash ?? "hash-1", opIndex: 0 },
      lines,
      ruleVersion,
      ...overrides.tx,
    }),
    breakdown,
  };
}

describe("money", () => {
  it("parses decimals to integer stroops without floating point", () => {
    expect(toStroops("1")).toBe(10_000_000n);
    expect(toStroops("0.0000001")).toBe(1n);
    expect(toStroops("100.5")).toBe(1_005_000_000n);
    expect(toStroops(-5n)).toBe(-5n);
  });

  it("round-trips through fromStroops", () => {
    expect(fromStroops(10_000_000n)).toBe("1");
    expect(fromStroops(1n)).toBe("0.0000001");
    expect(fromStroops(-15_000_000n)).toBe("-1.5");
  });

  it("rejects over-precise, non-finite, and non-integer numeric amounts", () => {
    expect(() => toStroops("1.23456789")).toThrow(MoneyError);
    expect(() => toStroops("1e5")).toThrow(MoneyError);
    expect(() => toStroops(1.5)).toThrow(MoneyError);
    expect(() => toStroops(Number.NaN)).toThrow(MoneyError);
  });

  it("builds canonical asset keys", () => {
    expect(assetKey("XLM")).toBe(NATIVE_ASSET_KEY);
    expect(assetKey(null)).toBe(NATIVE_ASSET_KEY);
    expect(assetKey("USDC", "GISSUER")).toBe("USDC:GISSUER");
  });

  it("floors division and returns the dust remainder", () => {
    expect(mulDivFloor(100n, 250n, 10_000n)).toEqual({ quotient: 2n, remainder: 5000n });
  });
});

describe("journal", () => {
  it("rejects non-positive line amounts", () => {
    expect(() => makeLine({ account: ACCOUNTS.SETTLEMENT, assetKey: ASSET, direction: DIRECTIONS.DEBIT, amount: 0n })).toThrow(
      LedgerError,
    );
  });

  it("detects unbalanced transactions per asset", () => {
    const lines = [
      makeLine({ account: ACCOUNTS.SETTLEMENT, assetKey: ASSET, direction: DIRECTIONS.DEBIT, amount: 100n }),
      makeLine({ account: ACCOUNTS.PLATFORM_FEE_REVENUE, assetKey: ASSET, direction: DIRECTIONS.CREDIT, amount: 90n }),
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerError);
  });

  it("derives idempotency keys from source identity", () => {
    expect(idempotencyKey({ network: "public", txHash: "h", opIndex: 2, eventType: "purchase" })).toBe(
      "public:h:2:purchase",
    );
    expect(() => idempotencyKey({ eventType: "adjustment" })).toThrow(LedgerError);
  });

  it("freezes posted transactions and their lines", () => {
    const { tx } = purchaseTx();
    expect(Object.isFrozen(tx)).toBe(true);
    expect(Object.isFrozen(tx.lines)).toBe(true);
    expect(() => {
      tx.lines[0].amount = "999";
    }).toThrow();
  });

  it("reverses a transaction by swapping directions without mutating the original", () => {
    const { tx } = purchaseTx();
    const reversal = reverseTransaction(tx, { reason: "test" });
    expect(reversal.eventType).toBe(EVENT_TYPES.REVERSAL);
    expect(reversal.reverses).toBe(tx.id);
    for (let i = 0; i < tx.lines.length; i += 1) {
      const expected = tx.lines[i].direction === "debit" ? "credit" : "debit";
      expect(reversal.lines[i].direction).toBe(expected);
    }
    // original untouched
    expect(tx.lines[0].direction).toBe("debit");
  });

  it("requires a businessRef for adjustments", () => {
    expect(() => createAdjustment({ lines: [] })).toThrow(LedgerError);
  });
});

describe("posting rules", () => {
  it("produces a balanced purchase (v1, fee on net)", () => {
    const { lines, breakdown } = postPurchase({
      gross: toStroops("100"),
      feeBps: 250,
      assetKey: ASSET,
      creatorId: "c1",
    });
    expect(() => assertBalanced(lines)).not.toThrow();
    expect(breakdown.fee).toBe(25_000_000n); // 2.5 USDC
    expect(breakdown.proceeds).toBe(975_000_000n); // 97.5 USDC
    expect(breakdown.fee + breakdown.proceeds).toBe(breakdown.net);
  });

  it("books a platform-funded discount as expense (v2) and stays balanced", () => {
    const { lines, breakdown } = postPurchase(
      { gross: toStroops("100"), discount: toStroops("10"), feeBps: 250, assetKey: ASSET, creatorId: "c1" },
      PURCHASE_RULE_VERSIONS.V2_PLATFORM_DISCOUNT,
    );
    expect(() => assertBalanced(lines)).not.toThrow();
    // creator paid on gross under this policy
    expect(breakdown.proceeds).toBe(975_000_000n);
    expect(breakdown.net).toBe(900_000_000n);
  });

  it("claws back proceeds and fee proportionally on partial refund", () => {
    const refund = postRefund({
      amount: toStroops("50"),
      original: { net: toStroops("100"), proceeds: toStroops("97.5"), creatorId: "c1", assetKey: ASSET },
    });
    expect(() => assertBalanced(refund.lines)).not.toThrow();
    expect(refund.breakdown.proceedsPortion + refund.breakdown.feePortion).toBe(toStroops("50"));
  });
});

describe("balances derivation", () => {
  it("derives creator earnings, platform revenue, and settlement from the ledger", () => {
    const { tx } = purchaseTx();
    const txs = [tx];
    expect(creatorEarnings(txs, "creator-1", ASSET)).toBe(975_000_000n);
    expect(platformRevenue(txs, ASSET)).toBe(25_000_000n);
    expect(settlementBalance(txs, ASSET)).toBe(1_000_000_000n);
  });

  it("keeps a zero trial balance per asset", () => {
    const { tx } = purchaseTx();
    for (const total of trialBalance([tx]).values()) {
      expect(total).toBe(0n);
    }
  });
});
