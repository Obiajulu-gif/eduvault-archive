/**
 * Asset-aware integer money for the accounting ledger.
 *
 * Every amount in the ledger is an integer number of stroops (1 stroop =
 * 10^-7 of a unit, matching Stellar's fixed-point representation) held as a
 * BigInt. Floating-point arithmetic is never used for money: decimal input is
 * parsed straight into integer stroops, and all math stays in BigInt.
 *
 * BigInt does not survive JSON/Mongo serialization, so amounts are persisted as
 * canonical base-10 strings via {@link serializeStroops} and read back with
 * {@link parseStroops}.
 */

/** Number of fractional digits in a unit (Stellar uses 7). */
export const STROOP_SCALE = 7;
const STROOP_FACTOR = 10n ** BigInt(STROOP_SCALE);

/** Canonical key for the native asset. */
export const NATIVE_ASSET_KEY = "native";

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const STROOP_STRING_PATTERN = /^-?\d+$/;

export class MoneyError extends Error {
  constructor(message, code = "invalid_amount") {
    super(message);
    this.name = "MoneyError";
    this.code = code;
  }
}

/**
 * Build a canonical asset key. The native asset collapses to
 * {@link NATIVE_ASSET_KEY}; issued assets are `CODE:ISSUER`.
 */
export function assetKey(code, issuer = null) {
  if (code == null || code === "" || code === "native" || code === "XLM") {
    if (issuer) return `${code}:${issuer}`;
    return NATIVE_ASSET_KEY;
  }
  const normalizedCode = String(code).trim();
  if (!normalizedCode) {
    throw new MoneyError("Asset code must not be empty", "invalid_asset");
  }
  if (!issuer) {
    // An issued asset without an issuer is ambiguous; keep the bare code so the
    // caller sees exactly what was supplied rather than silently guessing.
    return normalizedCode;
  }
  return `${normalizedCode}:${String(issuer).trim()}`;
}

/**
 * Convert a decimal string (or integer/bigint) to integer stroops.
 *
 * Accepts a plain decimal string with at most {@link STROOP_SCALE} fractional
 * digits, a safe integer, or a BigInt. Rejects floats, scientific notation,
 * NaN/Infinity, empty input, and over-precise values. Never uses Number math on
 * the fractional part, so no precision is lost.
 */
export function toStroops(value) {
  if (typeof value === "bigint") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MoneyError(`Amount is not finite: ${value}`);
    }
    if (!Number.isInteger(value)) {
      throw new MoneyError(
        `Numeric amounts must be integer stroops; got ${value}. Pass a decimal string for fractional units.`,
      );
    }
    return BigInt(value);
  }

  if (typeof value !== "string") {
    throw new MoneyError(`Unsupported amount type: ${typeof value}`);
  }

  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new MoneyError(`Amount is not a plain decimal string: "${value}"`);
  }

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ""] = unsigned.split(".");

  if (fraction.length > STROOP_SCALE) {
    throw new MoneyError(
      `Amount "${value}" has ${fraction.length} fractional digits; at most ${STROOP_SCALE} are allowed`,
      "precision_exceeded",
    );
  }

  const paddedFraction = fraction.padEnd(STROOP_SCALE, "0");
  const stroops = BigInt(whole) * STROOP_FACTOR + BigInt(paddedFraction || "0");
  return negative ? -stroops : stroops;
}

/** Format integer stroops as a canonical decimal string (trailing zeros trimmed). */
export function fromStroops(stroops) {
  const value = asStroops(stroops);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / STROOP_FACTOR;
  const fraction = abs % STROOP_FACTOR;

  let result = whole.toString();
  if (fraction > 0n) {
    const fractionStr = fraction.toString().padStart(STROOP_SCALE, "0").replace(/0+$/, "");
    result += `.${fractionStr}`;
  }
  return negative ? `-${result}` : result;
}

/** Coerce a value that is already stroops (BigInt or integer string) to BigInt. */
export function asStroops(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new MoneyError(`Stroop value must be an integer: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && STROOP_STRING_PATTERN.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new MoneyError(`Not a stroop value: ${String(value)}`);
}

/** Serialize integer stroops for storage (base-10 string). */
export function serializeStroops(value) {
  return asStroops(value).toString();
}

/** Parse a stored stroop string back to BigInt. */
export function parseStroops(value) {
  return asStroops(value);
}

/**
 * Floor-divide `amount * numerator / denominator` in integer space and return
 * both the quotient and the remainder, so callers can route dust deterministically.
 */
export function mulDivFloor(amount, numerator, denominator) {
  const a = asStroops(amount);
  const n = asStroops(numerator);
  const d = asStroops(denominator);
  if (d === 0n) {
    throw new MoneyError("Division by zero", "division_by_zero");
  }
  const product = a * n;
  const quotient = product / d;
  const remainder = product - quotient * d;
  return { quotient, remainder };
}
