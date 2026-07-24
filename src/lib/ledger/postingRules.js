/**
 * Versioned posting rules.
 *
 * A posting rule turns a business event (a purchase, a refund) plus a policy
 * (fee rate, discount treatment) into a set of balanced debit/credit lines. The
 * rule version is recorded on the resulting transaction so that changing fee,
 * discount, or payout policy never re-interprets already-posted history: old
 * transactions keep the version that produced them.
 *
 * All arithmetic is integer stroops. Fee division floors, and the flooring
 * remainder (dust) is routed deterministically to the platform fee so that
 * `settlement in == fee + proceeds` holds exactly.
 */

import { ACCOUNTS } from "./accounts.js";
import { DIRECTIONS, makeLine } from "./journal.js";
import { asStroops, mulDivFloor } from "./money.js";

export const BPS_DENOMINATOR = 10_000n;

export const PURCHASE_RULE_VERSIONS = Object.freeze({
  /** Fee charged on the discounted (net) price; discount is not grossed up. */
  V1_NET_FEE: "purchase.v1-net-fee",
  /** Platform funds the discount: creator is paid on gross, discount booked as expense. */
  V2_PLATFORM_DISCOUNT: "purchase.v2-platform-discount",
});

export const REFUND_RULE_VERSIONS = Object.freeze({
  /** Proportional clawback of proceeds and fee, dust routed to fee. */
  V1_PROPORTIONAL: "refund.v1-proportional",
});

function normalizePurchaseInput(input) {
  const gross = asStroops(input.gross);
  const discount = input.discount == null ? 0n : asStroops(input.discount);
  const feeBps = asStroops(input.feeBps ?? 0);
  if (gross <= 0n) throw new Error("Purchase gross must be positive");
  if (discount < 0n) throw new Error("Discount must not be negative");
  if (discount > gross) throw new Error("Discount must not exceed gross");
  if (feeBps < 0n || feeBps > BPS_DENOMINATOR) throw new Error("feeBps must be within [0, 10000]");
  if (!input.creatorId) throw new Error("Purchase requires a creatorId");
  const assetKey = input.assetKey;
  if (!assetKey) throw new Error("Purchase requires an assetKey");
  return { gross, discount, feeBps, assetKey, creatorId: String(input.creatorId) };
}

function creditLines({ assetKey, creatorId, fee, proceeds }) {
  const lines = [];
  if (fee > 0n) {
    lines.push(makeLine({ account: ACCOUNTS.PLATFORM_FEE_REVENUE, assetKey, direction: DIRECTIONS.CREDIT, amount: fee }));
  }
  if (proceeds > 0n) {
    lines.push(
      makeLine({
        account: ACCOUNTS.CREATOR_PAYABLE,
        subaccount: creatorId,
        assetKey,
        direction: DIRECTIONS.CREDIT,
        amount: proceeds,
      }),
    );
  }
  return lines;
}

/**
 * Produce balanced lines for a purchase.
 * @returns {{ lines: object[], ruleVersion: string, breakdown: object }}
 */
export function postPurchase(input, version = PURCHASE_RULE_VERSIONS.V1_NET_FEE) {
  const { gross, discount, feeBps, assetKey, creatorId } = normalizePurchaseInput(input);

  if (version === PURCHASE_RULE_VERSIONS.V1_NET_FEE) {
    const net = gross - discount;
    const { quotient: fee } = mulDivFloor(net, feeBps, BPS_DENOMINATOR);
    const proceeds = net - fee;
    const lines = [];
    if (net > 0n) {
      lines.push(makeLine({ account: ACCOUNTS.SETTLEMENT, assetKey, direction: DIRECTIONS.DEBIT, amount: net }));
    }
    lines.push(...creditLines({ assetKey, creatorId, fee, proceeds }));
    return { lines, ruleVersion: version, breakdown: { net, fee, proceeds, discount } };
  }

  if (version === PURCHASE_RULE_VERSIONS.V2_PLATFORM_DISCOUNT) {
    const net = gross - discount;
    const { quotient: fee } = mulDivFloor(gross, feeBps, BPS_DENOMINATOR);
    const proceeds = gross - fee;
    const lines = [];
    if (net > 0n) {
      lines.push(makeLine({ account: ACCOUNTS.SETTLEMENT, assetKey, direction: DIRECTIONS.DEBIT, amount: net }));
    }
    if (discount > 0n) {
      lines.push(
        makeLine({
          account: ACCOUNTS.PLATFORM_DISCOUNT_EXPENSE,
          assetKey,
          direction: DIRECTIONS.DEBIT,
          amount: discount,
        }),
      );
    }
    lines.push(...creditLines({ assetKey, creatorId, fee, proceeds }));
    return { lines, ruleVersion: version, breakdown: { net, fee, proceeds, discount, gross } };
  }

  throw new Error(`Unknown purchase rule version: ${version}`);
}

/**
 * Produce balanced lines for a refund of `amount` against an original purchase
 * breakdown `{ net, fee, proceeds, creatorId, assetKey }`.
 *
 * The credit side goes to SETTLEMENT for an already-settled refund, or to
 * REFUNDS_PAYABLE when the refund is accrued but not yet paid on-chain.
 */
export function postRefund(input, version = REFUND_RULE_VERSIONS.V1_PROPORTIONAL) {
  if (version !== REFUND_RULE_VERSIONS.V1_PROPORTIONAL) {
    throw new Error(`Unknown refund rule version: ${version}`);
  }
  const amount = asStroops(input.amount);
  const originalNet = asStroops(input.original.net);
  const originalProceeds = asStroops(input.original.proceeds);
  const assetKey = input.original.assetKey;
  const creatorId = String(input.original.creatorId);
  if (amount <= 0n) throw new Error("Refund amount must be positive");
  if (amount > originalNet) throw new Error("Refund amount must not exceed the original net");

  // Proportional clawback; flooring dust stays with the platform fee.
  const { quotient: proceedsPortion } = mulDivFloor(originalProceeds, amount, originalNet);
  const feePortion = amount - proceedsPortion;

  const settled = input.settlementState !== "pending";
  const creditAccount = settled ? ACCOUNTS.SETTLEMENT : ACCOUNTS.REFUNDS_PAYABLE;

  const lines = [];
  if (proceedsPortion > 0n) {
    lines.push(
      makeLine({
        account: ACCOUNTS.CREATOR_PAYABLE,
        subaccount: creatorId,
        assetKey,
        direction: DIRECTIONS.DEBIT,
        amount: proceedsPortion,
      }),
    );
  }
  if (feePortion > 0n) {
    lines.push(
      makeLine({ account: ACCOUNTS.PLATFORM_FEE_REVENUE, assetKey, direction: DIRECTIONS.DEBIT, amount: feePortion }),
    );
  }
  lines.push(makeLine({ account: creditAccount, assetKey, direction: DIRECTIONS.CREDIT, amount }));

  return { lines, ruleVersion: version, breakdown: { amount, proceedsPortion, feePortion } };
}

/**
 * Settlement of a previously accrued refund: move it from REFUNDS_PAYABLE to
 * SETTLEMENT once the on-chain payment is confirmed.
 */
export function postRefundSettlement({ amount, assetKey }) {
  const value = asStroops(amount);
  if (value <= 0n) throw new Error("Refund settlement amount must be positive");
  return {
    ruleVersion: REFUND_RULE_VERSIONS.V1_PROPORTIONAL,
    lines: [
      makeLine({ account: ACCOUNTS.REFUNDS_PAYABLE, assetKey, direction: DIRECTIONS.DEBIT, amount: value }),
      makeLine({ account: ACCOUNTS.SETTLEMENT, assetKey, direction: DIRECTIONS.CREDIT, amount: value }),
    ],
  };
}
