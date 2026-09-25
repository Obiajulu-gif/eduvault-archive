import { verifyRefundLimit } from '@/lib/checkout/refundVerifier';
import { isCompletedPurchaseStatus } from '@/lib/purchases/access';
import { NETWORK_PASSPHRASE } from '@/lib/config/chain';

/**
 * Server-side refund policy (Issue #27).
 *
 * `deriveRefundTerms` is the only place that turns a purchase record into the
 * destination/asset/amount/network that will actually move money. It never
 * reads a caller-supplied destination, amount, or asset — those are derived
 * exclusively from the trusted `purchases` record, so a compromised or
 * careless caller cannot redirect funds or inflate the refund amount.
 */

export const REFUND_POLICY_VERSION = '2026.1';

const REFUND_WINDOW_MS = Number(process.env.REFUND_WINDOW_DAYS || 30) * 24 * 60 * 60 * 1000;

const SETTLED_SETTLEMENT_STATES = new Set(['Refunded', 'Disputed', 'Expired']);

/**
 * @param {object} params
 * @param {object} params.purchase - trusted purchase record loaded from the DB
 * @param {number|string} [params.requestedAmount] - optional partial-refund amount; clamped/rejected, never trusted blindly
 * @returns {Promise<{eligible:false, reason:string} | {eligible:true, destination:string, assetCode:string, network:string, amount:number, remainingBefore:number}>}
 */
export async function deriveRefundTerms({ purchase, requestedAmount } = {}) {
  if (!purchase) {
    return { eligible: false, reason: 'purchase_not_found' };
  }

  if (!isCompletedPurchaseStatus(purchase.status)) {
    return { eligible: false, reason: 'purchase_not_finalized' };
  }

  if (purchase.settlementState && SETTLED_SETTLEMENT_STATES.has(purchase.settlementState)) {
    return { eligible: false, reason: `purchase_settlement_${purchase.settlementState.toLowerCase()}` };
  }

  if (!purchase.buyerAddress || !purchase.asset) {
    return { eligible: false, reason: 'purchase_missing_settlement_fields' };
  }

  const referenceDate = purchase.confirmedAt || purchase.purchasedAt || purchase.createdAt;
  if (referenceDate && Date.now() - new Date(referenceDate).getTime() > REFUND_WINDOW_MS) {
    return { eligible: false, reason: 'refund_window_expired' };
  }

  const paidAmount = parseFloat(purchase.amount);
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    return { eligible: false, reason: 'invalid_purchase_amount' };
  }

  const alreadyRefunded = Number(purchase.refundedAmount || 0);
  const remaining = paidAmount - alreadyRefunded;
  if (remaining <= 0) {
    return { eligible: false, reason: 'already_fully_refunded' };
  }

  const requested = requestedAmount != null ? Number(requestedAmount) : remaining;
  if (!Number.isFinite(requested) || requested <= 0) {
    return { eligible: false, reason: 'invalid_requested_amount' };
  }
  if (requested > remaining) {
    // Defined behavior: a claim for more than the refundable balance is
    // rejected outright rather than silently clamped — it either indicates a
    // stale client or a manipulated request.
    return { eligible: false, reason: 'requested_amount_exceeds_refundable_balance' };
  }

  if (purchase.transactionHash) {
    const verification = await verifyRefundLimit(purchase.transactionHash, requested);
    if (!verification.valid) {
      return { eligible: false, reason: verification.reason };
    }
  }

  return {
    eligible: true,
    destination: purchase.buyerAddress,
    assetCode: purchase.asset,
    network: NETWORK_PASSPHRASE,
    amount: requested,
    remainingBefore: remaining,
  };
}
