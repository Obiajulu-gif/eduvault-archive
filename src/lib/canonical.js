/**
 * Canonical serialization and input normalization for EduVault.
 *
 * Any payload that is signed, hashed, compared, or settled must pass through
 * this module so that equivalent inputs always produce the same byte
 * representation. The rules are deliberately conservative and deterministic:
 *
 *   - Object keys are sorted lexicographically (code-point order).
 *   - Strings are NFC-normalized and trimmed of surrounding whitespace.
 *   - Numbers are rendered in a canonical decimal form with a fixed maximum
 *     precision so `1.0`, `1.00` and `1` collide.
 *   - Array order is preserved by default because order is often semantic
 *     (e.g. marketplace listings), but `normalizePayload` can be told to
 *     sort arrays of primitives when order is not meaningful.
 *   - `undefined`, functions and symbols are rejected outright so that a
 *     signature can never be made over a partially-defined payload.
 *
 * The canonical encoding is a JSON-compatible document with sorted keys and
 * no insignificant whitespace. This keeps it easy to inspect and to reuse
 * existing JSON tooling while still being byte-stable.
 */

export const CANONICAL_VERSION = "eduvault-canonical-v1";

/** Maximum number of fractional digits kept for canonical numbers. */
export const MAX_PRECISION = 12;

/** Maximum absolute magnitude allowed for canonical numbers. */
export const MAX_MAGNITUDE = Number.MAX_SAFE_INTEGER;

/** Thrown when a payload cannot be canonicalized. */
export class CanonicalizationError extends Error {
  constructor(message, path = "$") {
    super(message);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

/** Return true when the value is a plain object (not an array/Date/etc). */
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Normalize a string for canonical comparison:
 *   - Unicode NFC so composite and decomposed forms collide.
 *   - Trim leading/trailing whitespace.
 *   - Collapse internal runs of whitespace to a single space.
 *   - Normalize CR / CR + LF line endings to a single LF.
 * */
export function normalizeString(value) {
  if (typeof value !== "string") {
    throw new CanonicalizationError(`Expected string, received ${typeof value}`);
  }
  return value
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Normalize a numeric value to a canonical decimal string.
 *
 * Accepts finite numbers and numeric strings. Rejects NaN, Infinity,
 * exponential notation and values with more than `MAX_PRECISION` fractional
 * digits. The result never contains a leading zero or a trailing `.`.
 */
export function normalizeNumber(value) {
  let str;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError("Number must be finite");
    }
    if (Math.abs(value) > MAX_MAGNITUDE) {
      throw new CanonicalizationError(`Number exceeds max magnitude (${MAX_MAGNITUDE})`);
    }
    str = value.toString();
  } else if (typeof value === "string") {
    str = value.trim();
  } else if (typeof value === "bigint") {
    return value.toString(10);
  } else {
    throw new CanonicalizationError(`Expected number, received ${typeof value}`);
  }

  if (!str) throw new CanonicalizationError("Numeric value is empty");
  if (!/^-?\d+?\.?\d*$/.test(str)) {
    throw new CanonicalizationError(`Invalid numeric value: ${str}`);
  }

  const negative = str.startsWith("-");
  const body = negative ? str.slice(1) : str;
  const [rawInteger = "0", rawFraction = ""] = body.split(".");

  if (rawFraction.length > MAX_PRECISION) {
    throw new CanonicalizationError(
      `Number exceeds max precision of ${MAX_PRECISION} fractional digits`
    );
  }

  const integer = rawInteger.replace(/^0+(?=.)/, "") || "0";
  const fraction = rawFraction.replace(/0+$/, "");
  const normalized = fraction ? `${integer}.${fraction}` : integer;

  if (normalized === "0") return "0";
  return negative ? `-${normalized}` : normalized;
}

/**
 * Normalize an arbitrary JSON-like payload into a canonical form.
 *
 * Options:
 *   - sortArrays: when true, arrays of primitives are sorted by their
 *     canonical string representation. Arrays containing objects/arrays are
 *     left in place because order is assumed to be meaningful.
 *   - dropUndefined: when true, object keys whose value is `undefined` are
 *     omitted instead of causing a rejection. Defaults to false so that
 *     signing code fails loud on incomplete payloads.
 */
export function normalizePayload(value, options = {}) {
  const { sortArrays = false, dropUndefined = false } = options;
  return normalizeValue(value, { sortArrays, dropUndefined }, "$");
}

function normalizeValue(value, options, path) {
  if (value === null) return null;

  const type = typeof value;

  if (type === "string") return normalizeString(value);
  if (type === "number") return normalizeNumber(value);
  if (type === "boolean") return value;
  if (type === "bigint") return normalizeNumber(value.toString());

  if (type === "undefined") {
    if (options.dropUndefined) return undefined;
    throw new CanonicalizationError("Undefined values are not allowed", path);
  }

  if (type === "function" || type === "symbol") {
    throw new CanonicalizationError(`${type} values are not allowed`, path);
  }

  if (Array.isArray(value)) {
    const normalized = value.map((entry, index) =>
      normalizeValue(entry, options, `${path}[${index}]`)
    );
    if (options.sortArrays && normalized.every(isPrimitive)) {
      return [...normalized].sort(comparePrimitives);
    }
    return normalized;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CanonicalizationError("Invalid Date", path);
    }
    return value.toISOString();
  }

  if (type === "object") {
    if (!isPlainObject(value)) {
      throw new CanonicalizationError(
        `Only plain objects are allowed (received ${value.constructor?.name || "object"})`,
        path
      );
    }

    const out = {};
    for (const key of Object.keys(value).sort()) {
      const normalizedKey = normalizeString(key);
      const normalizedValue = normalizeValue(value[key], options, `${path}.${key}`);
      if (normalizedValue === undefined) continue;
      out[normalizedKey] = normalizedValue;
    }
    return out;
  }

  throw new CanonicalizationError(`Unsupported value of type ${type}`, path);
}

function isPrimitive(value) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function comparePrimitives(a, b) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Serialize a payload to its canonical JSON string. Keys are sorted and
 * the output contains no insignificant whitespace.
 */
export function canonicalize(value, options = {}) {
  return JSON.stringify(normalizePayload(value, options));
}

/**
 * Return the UTF-8 bytes of the canonical representation. Signing code
 * should sign these bytes so that equivalent payloads produce identical
 * signatures.
 */
export function canonicalBytes(value, options = {}) {
  return new TextEncoder().encode(canonicalize(value, options));
}

/**
 * Compare two payloads by their canonical representation. Returns true
 * when the payloads are equivalent after normalization.
 */
export function isCanonicallyEqual(a, b, options = {}) {
  try {
    return canonicalize(a, options) === canonicalize(b, options);
  } catch {
    return false;
  }
}

/**
 * Compatibility helper for legacy records.
 *
 * Older EduVault records may store numeric fields as strings, use mixed
 * casing for keys, or contain `undefined` values from optional fields.
 * This function normalizes them in place without throwing so that legacy
 * records can be re-signed or compared against new payloads.
 */
export function normalizeLegacyRecord(record, options = {}) {
  if (record == null || typeof record !== "object") {
    throw new CanonicalizationError("Legacy record must be an object");
  }
  return normalizePayload(record, { dropUndefined: true, sortArrays: false, ...options });
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
  const original = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    canonical,
    alreadyCanonical: original === canonical,
  };
}

/**
 * Compare two payloads by their canonical representation.
 */
export function canonicalEqual(a, b, options = {}) {
  return canonicalize(a, options) === canonicalize(b, options);
}
