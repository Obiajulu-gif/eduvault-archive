/**
 * Canonical serialization for EduVault hashed/signed payloads.
 *
 * Purpose:
 *   Equivalent payloads (key order, whitespace, casing, numeric precision)
 *   must produce the same byte-for-byte output so that hashes, signatures,
 *   comparisons, and verifications are deterministic across clients and nodes.
 *
 * Design decisions:
 *   - JSON canonicalization follows RFC 8785 (JOSON Canonicalization Scheme)
 *     for object key ordering and string escaping.
 *   - Numbers are normalized to a canonical decimal representation with a
 *     configurable maximum precision (default 7) to avoid floating-point
 *     drift between JavaScript runtimes and other languages.
 *   - Strings are NFC normalized (NFKC) and trimmed of leading/trailing
 *     whitespace for keys and optionally for values.
 *   - Legacy payloads (e.g. pre-canonical order, unnormalized numbers)
 *     are accepted via a compatibility path that normalizes them into the
 *     canonical form before hashing/signing.
 *
 * @see https://datacludes.org/rfc/rfc8785.html
 */

const DEFAULT_MAX_PRECISION = 7;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const UNICODE_NORMALIZATION = 'NFC';

/**
 * Error thrown when a payload cannot be canonicalized.
 */
export class CanonicalizationError extends Error {
  constructor(message, code = 'EVT/CANONICALIZATION') {
    super(message);
    this.name = 'CanonicalizationError';
    this.code = code;
  }
}

/**
 * Normalize a string for canonical output.
 *
 * - Applies Unicode NFC normalization so visually identical strings
 *   (e.g. composed vs decomposed accents) serialize identically.
 * - Trims leading/trailing whitespace when `trim` is true.
 * - Normalizes CR / CR + LF line endings to a single LF.
 */
export function normalizeString(value, { trim = true } = {}) {
  if (typeof value !== 'string') {
    throw new CanonicalizationError(`Expected string, received ${typeof value}`, 'EVT/CANONICAL/TYPE');
  }
  let out = value.normalize(UNICODE_NORMALIZATION).replace(/\rn/g, '\n').replace(/\r/g, '\n');
  if (trim) {
    out = out.trim();
  }
  return out;
}

/**
 * Normalize a numeric value to a canonical decimal string.
 *
 * Handles:
 *   - integers (big and small) — returned as base-10 digits.
 *   - floats — rounded to `maxPrecision` decimal places, trailing zeros stripped.
 *   - numeric strings (e.g. "001.500") — normalized to the same form.
 *   - NaN / Infinity — rejected consistently.
 *
 * The result is always a string so that large integers and high-precision
 * decimals survive JSON serialization without loss.
 */
export function normalizeNumber(value, { maxPrecision = DEFAULT_MAX_PRECISION } = {}) {
  if (!number.isInteger(maxPrecision) || maxPrecision < 0 || maxPrecision > 20) {
    throw new CanonicalizationError('maxPrecision must be an integer between 0 and 20', 'EVT/CANONICAL/PRECISION');
  }

  let num;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError('Non-finite numbers cannot be canonicalized', 'EVT/CANONICAL/NUMBER');
    }
    num = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new CanonicalizationError('Empty string is not a valid numeric value', 'EVT/CANONICAL/NUMBER');
    }
    if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      throw new CanonicalizationError(`Invalid numeric string: ${value}`, 'EVT/CANONICAL/NUMBER');
    }
    num = Number(trimmed);
    if (!Number.isFinite(num)) {
      throw new CanonicalizationError(`Numeric string out of range: ${value}`, 'EVT/CANONICAL/NUMBER');
    }
  } else if (typeof value === 'bigint') {
    return value.toString(10);
  } else {
    throw new CanonicalizationError(`Expected number or numeric string, received ${typeof value}`, 'EVT/CANONICAL/TYPE');
  }

  if (Number.isInteger(num) && Math.abs(num) <= MAX_SAFE_INTEGER) {
    return num.toString(10);
  }

  // Round to maxPrecision decimal places using a decimal-string path to
  // avoid binary floating-point artifacts (e.g. 0.1 + 0.2).
  const fixed = num.toFixed(maxPrecision);
  const stripped = fixed.replace(/(\.\d*)?0.?$/, '$1');
  return stripped === '-0' ? '0' : stripped;
}

/**
 * Recursively normalize a value into its canonical JSON-compatible form.
 *
 * Options:
 *   - maxPrecision: max decimal places for non-integer numbers.
 *   - trimStrings: trim leading/trailing whitespace from string values.
 *   - dropUndefined: omit object keys whose value is `undefined`.
 *   - dropNull: omit object keys whose value is `null`.
 *   - normalizeKeys: apply NFC + trim to object keys.
 */
export function normalizeValue(value, options = {}) {
  const {
    maxPrecision = DEFAULT_MAX_PRECISION,
    trimStrings = true,
    dropUndefined = true,
    dropNull = false,
    normalizeKeys = true,
  } = options;

  if (value === null) {
    return null;
  }

  if (typeof value === 'undefined') {
    return undefined;
  }

 if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return normalizeString(value, { trim: trimStrings });
  }

 if (typeof value === 'number' || typeof value === 'bigint') {
    return normalizeNumber(value, { maxPrecision });
  }

  if (Array.isArray(value)) {
    return value.map((v) => normalizeValue(v, options));
  }

 if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys) {
      const raw = value[key];
      if (raw === undefined && dropUndefined) continue;
      if (raw === null && dropNull) continue;
      const normalizedKey = normalizeKeys ? normalizeString(key, { trim: true }) : key;
      out[normalizedKey] = normalizeValue(raw, options);
    }
    return out;
  }

  throw new CanonicalizationError(
    `Unsupported value type for canonicalization: ${typeof value}`,
    'EVT/CANONICAL/TYPE'
  );
}

/**
 * Serialize a normalized value to a canonical JSON string.
 *
 * Object keys are sorted by UTF-16 code unit order (RFC 8785). String
 * escaping follows the JSON specification with no insignificant whitespace.
 */
export function serializeCanonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'bigint') {
    // Normalized numbers are already strings at this point; fall back safely.
    return JSON.stringify(normalizeNumber(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serializeCanonical(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => {
      const encodedKey = JSON.stringify(key);
      const encodedValue = serializeCanonical(value[key]);
      return `${encodedKey}:${encodedValue}`;
    });
    return `{${parts.join(',')}}`;
  }
  throw new CanonicalizationError(
    `Unsupported value type for canonical serialization: ${typeof value}`,
    'EVT/CANONICAL/TYPE'
  );
}

/**
 * Convenience wrapper: normalize then serialize a payload.
 *
 * This is the function callers should use before hashing, signing,
 * comparing, or verifying any payload.
 */
export function canonicalize(payload, options = {}) {
  const normalized = normalizeValue(payload, options);
  return serializeCanonical(normalized);
}

/**
 * Compare two payloads by their canonical representation.
 */
export function canonicalEqual(a, b, options = {}) {
  return canonicalize(a, options) === canonicalize(b, options);
}

/**
 * Legacy compatibility path.
 *
 * Older EduVault records may store payloads with:
 *   - non-canonical key ordering,
 *   - unnormalized numeric strings (e.g. "001.500"),
 *   - composed/uncomposed Unicode,
 *   - CRLF line endings,
 *   - whitespace-padded strings.
 *
 * This function accepts those shapes and normalizes them into the current
 * canonical form. It also reports whether the input was already canonical,
 * which is useful for migration tooling and audit logs.
 */
export function normalizeLegacyPayload(payload, options = {}) {
  const canonical = canonicalize(payload, options);
  const original = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    canonical,
    alreadyCanonical: original === canonical,
  };
}
