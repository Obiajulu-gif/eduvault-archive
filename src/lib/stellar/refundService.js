import { TransactionBuilder, Networks, Asset, Operation } from '@stellar/stellar-sdk';
import { loadAccount, submitTransaction, resolveAssetIssuer } from './horizonClient';
import { calculateDynamicFee } from './checkoutService';
import { signRefundTransaction, getRefundSignerPublicKey } from './refundSigner';

const isMainnet = process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet';
const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET;

/**
 * Low-level Stellar execution for the refund workflow (Issue #27).
 *
 * This module only builds, signs, and submits a single payment transaction
 * moving funds from the constrained signer (src/lib/stellar/refundSigner.js)
 * to a destination — it holds no policy (amount derivation, idempotency,
 * entitlement revocation). That lives in src/lib/refunds/refundWorkflow.js,
 * which is the only caller these functions should have.
 *
 * Transaction-submission errors are classified into two buckets because they
 * require different recovery:
 *   - "rejected" (retryable: true)  — Horizon definitively rejected this exact
 *     envelope (bad sequence, bad auth, insufficient balance/fee). It never
 *     entered the ledger, so it is safe to rebuild a fresh envelope and retry.
 *   - "ambiguous" (retryable: false) — a timeout/network/5xx error where we
 *     never got a definitive answer. The transaction may still have been
 *     broadcast and could land later. The caller MUST reconcile by the
 *     precomputed transaction hash (getTransactionStatus) before doing
 *     anything else — rebuilding a new envelope here risks a double payment.
 */

const DEFINITIVE_REJECTION_CODES = new Set([
  'tx_bad_seq',
  'tx_bad_auth',
  'tx_bad_auth_extra',
  'tx_insufficient_balance',
  'tx_insufficient_fee',
  'tx_no_source_account',
  'tx_malformed',
]);

function buildAsset(assetCode) {
  if (assetCode === 'XLM') return Asset.native();
  const issuer = resolveAssetIssuer(assetCode);
  if (!issuer) {
    throw new Error(`No known issuer configured for asset ${assetCode}`);
  }
  return new Asset(assetCode, issuer);
}

/**
 * Read the refund signer's current balance for an asset, for the
 * treasury-shortage check performed before submitting a refund.
 *
 * @param {string} assetCode
 * @returns {Promise<number>}
 */
export async function getTreasuryBalance(assetCode) {
  const account = await loadAccount(getRefundSignerPublicKey());
  const balanceEntry =
    assetCode === 'XLM'
      ? account.balances.find((b) => b.asset_type === 'native')
      : account.balances.find((b) => b.asset_type !== 'native' && b.asset_code === assetCode);

  return balanceEntry ? parseFloat(balanceEntry.balance) : 0;
}

/**
 * Build (but do not sign or submit) a refund payment transaction. Returns the
 * transaction's hash up front so the caller can persist it durably *before*
 * submission — the crash-safety anchor the refund workflow reconciles
 * against if the process dies or Horizon times out mid-submission.
 *
 * @param {{ destination: string, amount: string|number, assetCode: string }} params
 * @returns {Promise<{ transaction: import('@stellar/stellar-sdk').Transaction, hash: string, sequence: string }>}
 */
export async function buildRefundTransaction({ destination, amount, assetCode }) {
  const signerAccount = await loadAccount(getRefundSignerPublicKey());
  const { feeStroops } = await calculateDynamicFee();

  const transaction = new TransactionBuilder(signerAccount, {
    fee: String(feeStroops),
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: buildAsset(assetCode),
        amount: String(amount),
      })
    )
    .setTimeout(30)
    .build();

  return {
    transaction,
    hash: transaction.hash().toString('hex'),
    sequence: signerAccount.sequenceNumber(),
  };
}

/**
 * Sign and submit a previously-built refund transaction.
 *
 * @param {import('@stellar/stellar-sdk').Transaction} transaction
 * @param {string|number} amount - re-validated against the signer's per-tx cap
 * @returns {Promise<
 *   | { outcome: 'confirmed', hash: string, ledger: number }
 *   | { outcome: 'blocked', retryable: false, reason: string }
 *   | { outcome: 'rejected', retryable: true, reason: string }
 *   | { outcome: 'ambiguous', retryable: false, reason: string }
 * >}
 */
export async function submitRefundTransaction(transaction, amount) {
  try {
    signRefundTransaction(transaction, amount);
  } catch (error) {
    // Never reached the network (signer disabled or over cap) — the built
    // transaction and its sequence number are still unused, so this is safe
    // to retry later once the operational block clears, with no rebuild.
    return { outcome: 'blocked', retryable: false, reason: error.message };
  }

  try {
    const result = await submitTransaction(transaction);
    return { outcome: 'confirmed', hash: result.hash, ledger: result.ledger };
  } catch (error) {
    const transactionCode = error?.response?.data?.extras?.result_codes?.transaction;
    if (transactionCode && DEFINITIVE_REJECTION_CODES.has(transactionCode)) {
      return { outcome: 'rejected', retryable: true, reason: transactionCode };
    }
    return {
      outcome: 'ambiguous',
      retryable: false,
      reason: error?.response?.data?.extras?.result_codes?.transaction || error.message,
    };
  }
}
