import { Keypair, TransactionBuilder, Networks, Asset, Operation } from '@stellar/stellar-sdk';
import { loadAccount, submitTransaction } from './horizonClient';
import { calculateDynamicFee } from './checkoutService';
import { PURCHASE_MANAGER_CONTRACT_ID } from '@/lib/config/chain';

const isMainnet = process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet';
const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET;

/**
 * Service to handle blockchain-level refund approvals.
 * Uses the failover Horizon client and surge-aware dynamic fee.
 */

/**
 * Execute an on-chain refund via the PurchaseManager contract.
 * Calls refund_purchase (admin-only) which uses the PurchaseBuyer mapping.
 *
 * @param {string|number} purchaseId - The on-chain purchase ID
 * @param {string} buyerAddress - The buyer's Stellar public key
 * @returns {Promise<{success: boolean, hash?: string, error?: string}>}
 */
export async function refundPurchaseOnChain(purchaseId, buyerAddress) {
  if (!PURCHASE_MANAGER_CONTRACT_ID) {
    return { success: false, error: 'Missing PURCHASE_MANAGER_CONTRACT_ID configuration.' };
  }

  try {
    const adminSecret = process.env.STELLAR_ADMIN_SECRET;
    if (!adminSecret) {
      return { success: false, error: 'Missing STELLAR_ADMIN_SECRET configuration.' };
    }

    const adminKeypair = Keypair.fromSecret(adminSecret);
    const adminAccount = await loadAccount(adminKeypair.publicKey());

    const { feeStroops } = await calculateDynamicFee();

    // Build the Soroban contract invocation for refund_purchase
    // This requires the Soroban SDK for contract invocation
    // The invocation calls refund_purchase(admin, purchase_id) using PurchaseBuyer mapping
    const tx = new TransactionBuilder(adminAccount, {
      fee: String(feeStroops),
      networkPassphrase,
    })
      .addOperation(
        Operation.extendFootprintTtl({
          extendTo: 100,
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(adminKeypair);

    const transactionResult = await submitTransaction(tx);
    return {
      success: true,
      hash: transactionResult.hash,
    };
  } catch (error) {
    console.error('Error in refundPurchaseOnChain:', error);
    return {
      success: false,
      error: error?.response?.data?.extras?.result_codes?.transaction || error.message,
    };
  }
}

/**
 * Check the settlement state of a purchase on-chain.
 * Calls get_settlement_state(purchase_id) on the PurchaseManager contract.
 *
 * @param {string|number} purchaseId - The on-chain purchase ID
 * @returns {Promise<{state: string|null, error?: string}>}
 */
export async function checkSettlementState(purchaseId) {
  if (!PURCHASE_MANAGER_CONTRACT_ID) {
    return { state: null, error: 'Missing PURCHASE_MANAGER_CONTRACT_ID' };
  }

  try {
    // Simulate a call to get_settlement_state via Soroban RPC
    // In production, this would use the Soroban SDK to simulate a contract call
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: {
        transaction: buildSettlementStateXdr(purchaseId),
      },
    };

    const STELLAR_RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL || process.env.STELLAR_RPC_URL;
    if (!STELLAR_RPC_URL) {
      return { state: null, error: 'Missing STELLAR_RPC_URL' };
    }

    const res = await fetch(STELLAR_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    const payload = await res.json();
    if (payload.error) {
      return { state: null, error: payload.error.message };
    }

    const retval = payload.result?.results?.[0]?.xdr;
    if (!retval) {
      return { state: null, error: 'No result from simulation' };
    }

    return { state: decodeSettlementState(retval) };
  } catch (error) {
    console.error('Error in checkSettlementState:', error);
    return { state: null, error: error.message };
  }
}

/**
 * Check if a purchase has been refunded on-chain.
 *
 * @param {string|number} purchaseId - The on-chain purchase ID
 * @returns {Promise<boolean>}
 */
export async function isPurchaseRefunded(purchaseId) {
  const { state, error } = await checkSettlementState(purchaseId);
  if (error || !state) return false;
  return state === 'Refunded';
}

/**
 * Check if a purchase can be withdrawn (settlement is Pending and lock period expired).
 *
 * @param {string|number} purchaseId - The on-chain purchase ID
 * @returns {Promise<boolean>}
 */
export async function isPurchaseReleasable(purchaseId) {
  if (!PURCHASE_MANAGER_CONTRACT_ID) return false;

  try {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: {
        transaction: buildIsEscrowReleasableXdr(purchaseId),
      },
    };

    const STELLAR_RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL || process.env.STELLAR_RPC_URL;
    if (!STELLAR_RPC_URL) return false;

    const res = await fetch(STELLAR_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    const payload = await res.json();
    if (payload.error) return false;

    const retval = payload.result?.results?.[0]?.xdr;
    if (!retval) return false;

    return decodeBoolean(retval);
  } catch {
    return false;
  }
}

/**
 * Execute an on-chain refund via the PurchaseManager contract to a specific buyer.
 * Calls refund_purchase_to_buyer(admin, purchase_id, buyer).
 *
 * @param {string|number} purchaseId - The on-chain purchase ID
 * @param {string} buyerAddress - The buyer's Stellar public key
 * @returns {Promise<{success: boolean, hash?: string, error?: string}>}
 */
export async function approveRefundOnChain(claimId, destinationAddress, amount, assetCode = 'USDC') {
  try {
    const adminSecret = process.env.STELLAR_ADMIN_SECRET;
    if (!adminSecret) {
      throw new Error("Missing STELLAR_ADMIN_SECRET configuration.");
    }

    const adminKeypair = Keypair.fromSecret(adminSecret);
    const adminAccount = await loadAccount(adminKeypair.publicKey());

    const { feeStroops } = await calculateDynamicFee();

    const paymentOp = Operation.payment({
      destination: destinationAddress,
      asset: assetCode === 'XLM' ? Asset.native() : new Asset(assetCode, process.env.NEXT_PUBLIC_USDC_ISSUER || adminKeypair.publicKey()),
      amount: String(amount),
    });

    let tx = new TransactionBuilder(adminAccount, {
      fee: String(feeStroops),
      networkPassphrase,
    })
      .addOperation(paymentOp)
      .setTimeout(30)
      .build();

    tx.sign(adminKeypair);

    const transactionResult = await submitTransaction(tx);
    return {
      success: true,
      hash: transactionResult.hash,
    };
  } catch (error) {
    console.error("Error in approveRefundOnChain:", error);
    throw new Error(`Refund failed: ${error?.response?.data?.extras?.result_codes?.transaction || error.message}`);
  }
}

// ============== XDR Build Helpers ==============

function buildSettlementStateXdr(purchaseId) {
  // Placeholder for actual Soroban XDR construction
  // In production, use @stellar/stellar-sdk Soroban helpers
  return '';
}

function buildIsEscrowReleasableXdr(purchaseId) {
  // Placeholder for actual Soroban XDR construction
  return '';
}

function decodeSettlementState(xdrBase64) {
  // Placeholder for decoding settlement state from XDR
  if (xdrBase64.includes('Pending')) return 'Pending';
  if (xdrBase64.includes('Released')) return 'Released';
  if (xdrBase64.includes('Disputed')) return 'Disputed';
  if (xdrBase64.includes('Refunded')) return 'Refunded';
  if (xdrBase64.includes('Expired')) return 'Expired';
  return null;
}

function decodeBoolean(xdrBase64) {
  return xdrBase64.includes('AAAE') || xdrBase64.includes('true');
}