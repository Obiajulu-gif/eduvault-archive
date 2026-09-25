import { Keypair } from '@stellar/stellar-sdk';

/**
 * Custody boundary for refund signing (Issue #27).
 *
 * Every refund payment must be signed through this module rather than by
 * loading `STELLAR_ADMIN_SECRET` directly in business logic — it is the one
 * place that enforces the signer-layer controls that hold even if the
 * application-layer amount checks are ever wrong or bypassed:
 *
 *   - a hard per-transaction cap (`REFUND_MAX_AMOUNT_PER_TX`), independent of
 *     whatever amount the refund workflow computed
 *   - an emergency kill switch (`REFUND_SIGNING_DISABLED=true`) that refuses
 *     to sign anything, for incident response
 *
 * This is a single hot-wallet keypair, not a KMS/HSM/multisig integration —
 * no such infrastructure exists in this codebase today. Least-privilege,
 * rotation, and emergency-disable operational procedures for this key are
 * documented in docs/refund-custody.md.
 */

let cachedKeypair;

function loadKeypair() {
  if (cachedKeypair) return cachedKeypair;
  const secret = process.env.STELLAR_ADMIN_SECRET;
  if (!secret) {
    throw new Error('Missing STELLAR_ADMIN_SECRET configuration.');
  }
  cachedKeypair = Keypair.fromSecret(secret);
  return cachedKeypair;
}

/** Emergency disable — set REFUND_SIGNING_DISABLED=true to halt all refund signing. */
export function isRefundSigningEnabled() {
  return process.env.REFUND_SIGNING_DISABLED !== 'true';
}

/** Hard per-transaction cap enforced at the signer layer, independent of app-layer checks. */
export function getRefundSignerMaxAmount() {
  const raw = process.env.REFUND_MAX_AMOUNT_PER_TX;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity;
}

export function getRefundSignerPublicKey() {
  return loadKeypair().publicKey();
}

/** Throws if the amount exceeds the signer's configured per-transaction cap. */
export function assertWithinSignerLimit(amount) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Invalid refund amount');
  }
  const max = getRefundSignerMaxAmount();
  if (numericAmount > max) {
    throw new Error(`Refund amount ${numericAmount} exceeds signer per-transaction cap ${max}`);
  }
}

/**
 * Sign a built (unsigned) refund transaction. Throws if signing is disabled
 * or the amount was never checked against the signer cap.
 *
 * @param {import('@stellar/stellar-sdk').Transaction} transaction
 * @param {string|number} amount - amount being moved, re-checked here as a last line of defense
 */
export function signRefundTransaction(transaction, amount) {
  if (!isRefundSigningEnabled()) {
    throw new Error('Refund signing is disabled (REFUND_SIGNING_DISABLED=true)');
  }
  assertWithinSignerLimit(amount);
  transaction.sign(loadKeypair());
  return transaction;
}
