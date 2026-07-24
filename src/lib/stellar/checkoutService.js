import { fetchFeeStats } from './horizonClient';

// NOTE: We intentionally avoid importing @/lib/logger here because this module
// is transitively bundled into client-side code (via CheckoutInvoice → CartDrawer).
// The logger depends on telemetry/context.js which uses node:async_hooks and
// node:crypto — modules unavailable in the browser webpack build.
const checkoutLogger = {
  warn(data, message) {
    console.warn(message, data);
  },
  info(data, message) {
    console.info(message, data);
  },
  error(data, message) {
    console.error(message, data);
  },
};

// Base fee stroops (100 stroops = 0.00001 XLM per operation is Stellar's minimum)
const BASE_FEE_STROOPS = 100;

// Congestion thresholds (p95 fee in stroops)
const SURGE_THRESHOLD_STROOPS = Number(process.env.STELLAR_SURGE_FEE_THRESHOLD || 500);

// Multipliers applied during congestion (configurable via env)
const SURGE_MULTIPLIER = Number(process.env.STELLAR_SURGE_FEE_MULTIPLIER || 3);
const HIGH_SURGE_MULTIPLIER = Number(process.env.STELLAR_HIGH_SURGE_FEE_MULTIPLIER || 5);

// Hard ceiling for the fee we are willing to pay (in stroops)
const MAX_FEE_STROOPS = Number(process.env.STELLAR_MAX_FEE_STROOPS || 10000);

// Wallet address mismatch: maximum warnings before session is cleared
const MAX_ADDRESS_WARNINGS = Number(process.env.CHECKOUT_MAX_ADDRESS_WARNINGS || 2);

/**
 * Detect whether the network is currently surging based on Horizon fee stats.
 *
 * @returns {Promise<{ surging: boolean, p95Fee: number, p99Fee: number }>}
 */
export async function detectSurgePricing() {
  try {
    const stats = await fetchFeeStats();
    const p95 = Number(stats.fee_charged?.p95 ?? stats.max_fee?.p95 ?? BASE_FEE_STROOPS);
    const p99 = Number(stats.fee_charged?.p99 ?? stats.max_fee?.p99 ?? BASE_FEE_STROOPS);

    const surging = p95 > SURGE_THRESHOLD_STROOPS;

    if (surging) {
      checkoutLogger.warn({ p95, p99, threshold: SURGE_THRESHOLD_STROOPS }, 'Stellar network surge detected');
    }

    return { surging, p95Fee: p95, p99Fee: p99 };
  } catch (err) {
    checkoutLogger.warn({ err: err.message }, 'Failed to fetch Horizon fee stats — assuming no surge');
    return { surging: false, p95Fee: BASE_FEE_STROOPS, p99Fee: BASE_FEE_STROOPS };
  }
}

/**
 * Calculate the recommended transaction fee in stroops.
 * Applies a surge multiplier when the network is congested, capped at MAX_FEE_STROOPS.
 *
 * @returns {Promise<{ feeStoops: number, surging: boolean, p95Fee: number }>}
 */
export async function calculateDynamicFee() {
  const { surging, p95Fee, p99Fee } = await detectSurgePricing();

  let recommendedFee = BASE_FEE_STROOPS;

  if (surging) {
    const multiplier = p99Fee > SURGE_THRESHOLD_STROOPS * 2 ? HIGH_SURGE_MULTIPLIER : SURGE_MULTIPLIER;
    recommendedFee = Math.min(Math.ceil(p95Fee * multiplier), MAX_FEE_STROOPS);

    checkoutLogger.info(
      { p95Fee, p99Fee, multiplier, recommendedFee },
      'Surge fee applied to checkout transaction'
    );
  }

  return { feeStroops: recommendedFee, surging, p95Fee };
}

/**
 * Verify that the wallet address in the signed checkout payload matches the
 * address stored in the user's session token.  Prevents address-spoofing
 * attacks where a buyer substitutes another wallet's signed credentials.
 *
 * @param {object} params
 * @param {string} params.sessionAddress  - Stellar G-address from the JWT session
 * @param {string} params.payloadAddress  - Stellar G-address extracted from the signed payload
 * @param {object} [params.sessionState]  - Mutable session state for warning tracking
 * @returns {{ valid: boolean, reason?: string, clearSession?: boolean }}
 */
export function verifyWalletAddressMatch({ sessionAddress, payloadAddress, sessionState = {} }) {
  if (!sessionAddress || !payloadAddress) {
    return { valid: false, reason: 'missing_address' };
  }

  const normalised = (addr) => addr.trim().toUpperCase();
  const sessionNorm = normalised(sessionAddress);
  const payloadNorm = normalised(payloadAddress);

  if (sessionNorm !== payloadNorm) {
    const warnings = (sessionState.addressMismatchWarnings ?? 0) + 1;
    sessionState.addressMismatchWarnings = warnings;

    checkoutLogger.warn(
      { sessionAddress: sessionNorm, payloadAddress: payloadNorm, warnings },
      'Wallet address mismatch detected at checkout'
    );

    const clearSession = warnings >= MAX_ADDRESS_WARNINGS;
    if (clearSession) {
      checkoutLogger.error(
        { sessionAddress: sessionNorm, payloadAddress: payloadNorm },
        'Repeated address mismatch — clearing session'
      );
    }

    return {
      valid: false,
      reason: 'address_mismatch',
      warnings,
      clearSession,
    };
  }

  // Reset warning counter on success
  sessionState.addressMismatchWarnings = 0;
  return { valid: true };
}

/**
 * Validate that a wallet has enough XLM to cover the total price and estimated gas fee.
 * 
 * @param {object} params
 * @param {string} params.walletAddress - Stellar G-address of the buyer
 * @param {number} params.totalPrice - Total price of the checkout items (in XLM)
 * @param {number} params.estimatedGas - Estimated gas fee (in XLM)
 * @returns {Promise<{ hasEnough: boolean, balance: number, required: number, remainingBalance: number }>}
 */
export async function validateCheckoutBalance({ walletAddress, totalPrice, estimatedGas }) {
  try {
    const { loadAccount } = await import('./horizonClient');
    const account = await loadAccount(walletAddress);
    const nativeBalanceObj = account.balances.find(b => b.asset_type === 'native');
    const nativeBalance = nativeBalanceObj ? parseFloat(nativeBalanceObj.balance) : 0;
    const required = totalPrice + estimatedGas;
    
    // In Stellar, the account minimum balance is 1 XLM. Let's subtract the required amount.
    const remainingBalance = nativeBalance - required;
    const hasEnough = remainingBalance >= 0;

    return {
      hasEnough,
      balance: nativeBalance,
      required,
      remainingBalance
    };
  } catch (err) {
    // If account not found (e.g., 404)
    return { hasEnough: false, balance: 0, required: totalPrice + estimatedGas, remainingBalance: -(totalPrice + estimatedGas) };
  }
}
