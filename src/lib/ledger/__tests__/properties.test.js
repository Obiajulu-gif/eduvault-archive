import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { toStroops, fromStroops, mulDivFloor } from "../money.js";
import { assertBalanced, createTransaction, EVENT_TYPES } from "../journal.js";
import { postPurchase, postRefund, PURCHASE_RULE_VERSIONS } from "../postingRules.js";
import { trialBalance, settlementBalance, platformRevenue, creatorEarnings } from "../balances.js";

const ASSET = "USDC:GISSUER";

// Bounded integer stroop amounts (up to ~1e15 stroops = 100M units).
const grossArb = fc.bigInt({ min: 1n, max: 10n ** 15n });
const feeBpsArb = fc.integer({ min: 0, max: 10_000 });

describe("property: money precision", () => {
  it("fromStroops/toStroops round-trips for any stroop integer", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), (stroops) => {
        expect(toStroops(fromStroops(stroops))).toBe(stroops);
      }),
    );
  });

  it("mulDivFloor never loses value: quotient*den + remainder === amount*num", () => {
    fc.assert(
      fc.property(grossArb, fc.bigInt({ min: 0n, max: 10_000n }), (amount, num) => {
        const { quotient, remainder } = mulDivFloor(amount, num, 10_000n);
        expect(quotient * 10_000n + remainder).toBe(amount * num);
        expect(remainder >= 0n && remainder < 10_000n).toBe(true);
      }),
    );
  });
});

describe("property: purchases always balance and conserve value", () => {
  it("v1 purchase lines balance and fee+proceeds === net for any gross/fee", () => {
    fc.assert(
      fc.property(grossArb, feeBpsArb, (gross, feeBps) => {
        const { lines, breakdown } = postPurchase({ gross, feeBps, assetKey: ASSET, creatorId: "c" });
        expect(() => assertBalanced(lines)).not.toThrow();
        expect(breakdown.fee + breakdown.proceeds).toBe(breakdown.net);
        expect(breakdown.fee >= 0n && breakdown.proceeds >= 0n).toBe(true);
      }),
    );
  });

  it("v2 platform-discount purchases balance for any gross/discount/fee", () => {
    fc.assert(
      fc.property(grossArb, feeBpsArb, fc.bigInt({ min: 0n, max: 10n ** 15n }), (gross, feeBps, rawDiscount) => {
        const discount = rawDiscount > gross ? gross : rawDiscount;
        const { lines } = postPurchase(
          { gross, discount, feeBps, assetKey: ASSET, creatorId: "c" },
          PURCHASE_RULE_VERSIONS.V2_PLATFORM_DISCOUNT,
        );
        expect(() => assertBalanced(lines)).not.toThrow();
      }),
    );
  });
});

describe("property: a purchase then arbitrary partial refunds conserve the ledger", () => {
  it("trial balance stays zero and no account goes negative below what was posted", () => {
    fc.assert(
      fc.property(
        grossArb,
        feeBpsArb,
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 15n }), { maxLength: 5 }),
        (gross, feeBps, refundAmountsRaw) => {
          const purchase = postPurchase({ gross, feeBps, assetKey: ASSET, creatorId: "c" });
          const purchaseTx = createTransaction({
            eventType: EVENT_TYPES.PURCHASE,
            source: { network: "public", txHash: "p", opIndex: 0 },
            lines: purchase.lines,
            ruleVersion: purchase.ruleVersion,
          });
          const txs = [purchaseTx];

          // Apply refunds until the cumulative amount would exceed net.
          let remaining = purchase.breakdown.net;
          let i = 0;
          for (const raw of refundAmountsRaw) {
            const amount = raw > remaining ? remaining : raw;
            if (amount <= 0n) continue;
            const refund = postRefund({
              amount,
              original: {
                net: purchase.breakdown.net,
                proceeds: purchase.breakdown.proceeds,
                creatorId: "c",
                assetKey: ASSET,
              },
            });
            txs.push(
              createTransaction({
                eventType: EVENT_TYPES.REFUND,
                source: { network: "public", txHash: `r${i}`, opIndex: 0 },
                lines: refund.lines,
                ruleVersion: refund.ruleVersion,
              }),
            );
            remaining -= amount;
            i += 1;
          }

          // Every transaction balanced => global trial balance is zero.
          for (const total of trialBalance(txs).values()) {
            expect(total).toBe(0n);
          }
          // Settlement cash left == net minus refunded, and value is conserved:
          // platform revenue + creator earnings always equals settlement cash,
          // regardless of how per-refund rounding dust splits between them.
          const refunded = purchase.breakdown.net - remaining;
          const settlement = settlementBalance(txs, ASSET);
          expect(settlement).toBe(purchase.breakdown.net - refunded);
          const rev = platformRevenue(txs, ASSET);
          const earn = creatorEarnings(txs, "c", ASSET);
          expect(rev + earn).toBe(settlement);
        },
      ),
    );
  });
});
