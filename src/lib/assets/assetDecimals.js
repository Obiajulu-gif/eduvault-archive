/**
 * Canonical Asset Decimal & Minor-Unit Converter (Issue #710).
 *
 * Enforces consistent minor-unit representation across XLM, USDC, UI display,
 * and contract i128 amounts. Guarantees refunds cannot round above original payment.
 */

export const DEFAULT_ASSET_DECIMALS = {
  XLM: 7,
  NATIVE: 7,
  USDC: 7,
  EURC: 7,
};

export function getAssetDecimals(assetCode, customDecimals = null) {
  if (customDecimals != null && Number.isInteger(customDecimals) && customDecimals >= 0 && customDecimals <= 18) {
    return customDecimals;
  }
  const code = typeof assetCode === 'string' ? assetCode.toUpperCase().split(':')[0] : 'NATIVE';
  return DEFAULT_ASSET_DECIMALS[code] ?? 7;
}

/**
 * Converts a human-readable display amount to minor units (e.g. "10.5" XLM with 7 decimals -> 105000000).
 * Uses BigInt math to prevent floating point imprecision.
 */
export function toMinorUnits(displayAmount, decimals = 7) {
  if (displayAmount == null || displayAmount === '') {
    throw new Error('invalid_display_amount');
  }
  const str = String(displayAmount).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error('invalid_display_amount_format');
  }

  const [integerPart, fractionalPart = ''] = str.split('.');
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) {
    throw new Error('invalid_decimals');
  }

  const paddedFraction = fractionalPart.padEnd(dec, '0').slice(0, dec);
  const combinedStr = integerPart + paddedFraction;

  const BigIntVal = BigInt(combinedStr);
  if (BigIntVal > BigInt('170141183460469231731687303715884105727')) { // i128 max boundary
    throw new Error('amount_exceeds_max_i128_boundary');
  }

  return BigIntVal;
}

/**
 * Converts minor-unit amount back to human-readable display string.
 */
export function toDisplayAmount(minorUnits, decimals = 7) {
  const dec = Number(decimals);
  const big = BigInt(minorUnits);
  if (big < 0n) {
    throw new Error('negative_minor_units_not_allowed');
  }
  if (dec === 0) {
    return big.toString();
  }

  const scale = 10n ** BigInt(dec);
  const integerPart = (big / scale).toString();
  const remainder = (big % scale).toString().padStart(dec, '0');

  // Trim trailing zeros after decimal point for clean display while preserving representation
  const cleanRemainder = remainder.replace(/0+$/, '');
  return cleanRemainder.length > 0 ? `${integerPart}.${cleanRemainder}` : integerPart;
}

/**
 * Calculates maximum allowable refund in minor units given original payment in minor units and basis points (bps).
 *
 * Invariant: Truncates downwards so refund can NEVER round above original payment.
 */
export function calculateMaxRefundMinorUnits(originalPaymentMinorUnits, refundRatioBps = 10000) {
  const original = BigInt(originalPaymentMinorUnits);
  if (original <= 0n) return 0n;

  const bps = BigInt(Math.min(10000, Math.max(0, Number(refundRatioBps) || 0)));
  const refundAmount = (original * bps) / 10000n; // Integer division naturally truncates

  if (refundAmount > original) {
    return original;
  }
  return refundAmount;
}
