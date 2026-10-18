/**
 * Canonical serialization and input normalization for EduVault.
 *
 * Any payload that is signed, hashed, compared, or settled must pass through
 * this module so that equivalent inputs always produce the same byte
 * representation. The rules are deliberately conservative and deterministic:
 *
 *   - Object keys are sorted lexicographically (code-point order) and normalized
 *     to lowercase with surrounding whitespace stripped.
 *   - Strings are NFC-normalized and trimmed of surrounding whitespace.
 *   - Numbers are rendered in a canonical form so `1.0`, `1.00` and `1` collide,
 *     `-0` normalizes to `0`, and IEEE-754 precision is preserved.
 *   - Array order is preserved by default because order is often semantic
 *     (e.g. marketplace listings), but `normalizePayload` can be told to
 *     sort arrays of primitives when order is not meaningful.
 *   - `undefined`, functions and symbols are rejected outright so that a
 *     signature can never be made over a partially-defined payload.
 *   - Legacy payloads with dotted flat key paths, XML-style array wrappers
 *     `{ item: [...] }`, or boolean strings `'TRUE'`/`'False'` are normalized
 *     compatibly, while unknown legacy formats are rejected.
 *
 * The canonical encoding is a JSON-compatible document with sorted keys and
 * no insignificant whitespace. This keeps it easy to inspect and to reuse
 * existing JSON tooling while still being byte-stable.
 */

import crypto from "node:crypto";

export const CANONICAL_VERSION = "eduvault-canonical-v1";

/** Maximum number of fractional digits kept for canonical numbers. */
export const MAX_PRECISION = 20;

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
 *   - Normalize CR / CR + LF line endings to a single LF.
 *   - Collapse internal runs of whitespace to a single space.
 *   - Trim leading/trailing whitespace.
 */
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
 * Normalize a numeric value to a canonical representation.
 *
 * Accepts finite numbers and numeric strings. Rejects NaN, Infinity,
 * and numbers exceeding MAX_MAGNITUDE.
 * Normalizes -0 to 0, integer floats (e.g. 1.0) to 1, while preserving
 * standard decimal precision.
 */
export function normalizeNumber(value) {
  let num;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new CanonicalizationError("Numeric value is empty");
    num = Number(trimmed);
  } else if (typeof value === "bigint") {
    num = Number(value);
  } else {
    throw new CanonicalizationError(`Expected number, received ${typeof value}`);
  }

  if (!Number.isFinite(num)) {
    throw new CanonicalizationError("Number must be finite");
  }
  if (Math.abs(num) > MAX_MAGNITUDE) {
    throw new CanonicalizationError(`Number exceeds max magnitude (${MAX_MAGNITUDE})`);
  }
  if (Object.is(num, -0) || num === 0) {
    return 0;
  }
  return num;
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
  if (type === "bigint") return normalizeNumber(value);

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

    const rawKeys = Object.keys(value);
    const normalizedEntries = [];
    const seenKeys = new Set();
    for (const rawKey of rawKeys) {
      const normKey = rawKey.trim().toLowerCase();
      if (seenKeys.has(normKey)) {
        throw new CanonicalizationError(`Duplicate key after normalization: ${normKey}`, path);
      }
      seenKeys.add(normKey);
      normalizedEntries.push({ rawKey, normKey });
    }
    normalizedEntries.sort((a, b) => (a.normKey < b.normKey ? -1 : a.normKey > b.normKey ? 1 : 0));

    const out = {};
    for (const { rawKey, normKey } of normalizedEntries) {
      const normalizedValue = normalizeValue(value[rawKey], options, `${path}.${normKey}`);
      if (normalizedValue === undefined) continue;
      out[normKey] = normalizedValue;
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
 * Serialize a payload to its canonical JSON string. Keys are sorted,
 * normalized to lowercase, and the output contains no insignificant whitespace.
 */
export function canonicalize(value, options = {}) {
  return JSON.stringify(normalizePayload(value, options));
}

/**
 * Return valid JSON matching canonicalize.
 */
export function canonicalJson(value, options = {}) {
  return canonicalize(value, options);
}

/**
 * Serialize a primitive or payload to a canonical string.
 * Top-level strings are formatted as `[value:string]` for type disambiguation,
 * while objects and arrays are formatted as canonical JSON.
 */
export function canonicalString(value) {
  if (typeof value === "string") {
    return `[${normalizeString(value)}:string]`;
  }
  return canonicalJson(value);
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
 * Compare two payloads by their canonical representation.
 */
export function canonicalEqual(a, b, options = {}) {
  return canonicalize(a, options) === canonicalize(b, options);
}

/**
 * Assert that a payload is already in canonical form. Throws CanonicalizationError
 * if keys are not lowercase, unsorted, contains unnormalized whitespace,
 * or contains forbidden values.
 */
export function assertCanonical(payload, options = {}) {
  if (payload === undefined) {
    throw new CanonicalizationError("Payload cannot be undefined");
  }
  let canonical;
  try {
    canonical = canonicalize(payload, options);
  } catch (err) {
    throw new CanonicalizationError(`Payload is not canonical: ${err.message}`);
  }

  const original = JSON.stringify(payload);
  if (original !== canonical) {
    throw new CanonicalizationError("Payload is not in canonical form");
  }
}

/**
 * Unflattens dotted key paths (e.g. 'user.name' -> { user: { name: ... } }).
 */
function unflattenDottedKeys(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return obj;
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const processedValue =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? unflattenDottedKeys(value)
        : value;

    if (key.includes(".")) {
      const parts = key.split(".");
      let current = result;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) {
          current[part] = {};
        }
        current = current[part];
      }
      const last = parts[parts.length - 1];
      if (
        typeof current[last] === "object" &&
        current[last] !== null &&
        typeof processedValue === "object" &&
        processedValue !== null
      ) {
        Object.assign(current[last], processedValue);
      } else {
        current[last] = processedValue;
      }
    } else {
      if (
        typeof result[key] === "object" &&
        result[key] !== null &&
        typeof processedValue === "object" &&
        processedValue !== null
      ) {
        Object.assign(result[key], processedValue);
      } else {
        result[key] = processedValue;
      }
    }
  }
  return result;
}

/**
 * Normalize legacy payloads including:
 *   - dotted flat key paths
 *   - legacy XML/wrapper shapes `{ items: { item: [1, 2, 3] } }`
 *   - legacy boolean strings ('TRUE'/'False' -> true/false)
 * Rejects unknown legacy wrapper formats like `{ items: { wrapped: [1] } }`.
 */
export function normalizeLegacy(value, parentKey = "") {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeLegacy(item, parentKey));
  }

  const unflattened = unflattenDottedKeys(value);
  const out = {};

  for (const [key, rawVal] of Object.entries(unflattened)) {
    if (rawVal !== null && typeof rawVal === "object" && !Array.isArray(rawVal)) {
      const innerKeys = Object.keys(rawVal);
      if (innerKeys.length === 1 && Array.isArray(rawVal[innerKeys[0]])) {
        const innerKey = innerKeys[0];
        const normalizedInnerKey = innerKey.trim().toLowerCase();
        const singularParent = key.trim().toLowerCase().replace(/s$/, "");
        if (normalizedInnerKey === "item" || normalizedInnerKey === singularParent) {
          out[key] = rawVal[innerKey].map((item) => normalizeLegacy(item, key));
          continue;
        } else {
          throw new CanonicalizationError(
            `Unknown legacy format: array wrapper "${innerKey}" under "${key}"`
          );
        }
      }
    }

    out[key] = normalizeLegacy(rawVal, key);
  }

  return out;
}

/**
 * Normalizes legacy records and serializes to canonical JSON.
 */
export function canonicalizeLegacy(payload, options = {}) {
  const normalized = normalizeLegacy(payload);
  return canonicalize(normalized, options);
}

/**
 * Deterministically compute a SHA-256 hex digest of a payload using canonical serialization.
 */
export function canonicalHash(payload, options = {}) {
  let serialized;
  if (typeof payload === "string") {
    serialized = canonicalString(payload);
  } else {
    serialized = canonicalizeLegacy(payload, options);
  }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

/**
 * Compatibility helper for legacy records.
 * Normalizes them without throwing on undefined values so that legacy records
 * can be re-signed or compared against new payloads.
 */
export function normalizeLegacyRecord(record, options = {}) {
  if (record == null || typeof record !== "object") {
    throw new CanonicalizationError("Legacy record must be an object");
  }
  const legacyNorm = normalizeLegacy(record);
  return normalizePayload(legacyNorm, { dropUndefined: true, sortArrays: false, ...options });
}

/**
 * Legacy compatibility path that reports whether the input was already canonical.
 */
export function normalizeLegacyPayload(payload, options = {}) {
  const canonical = canonicalizeLegacy(payload, options);
  const original = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    canonical,
    alreadyCanonical: original === canonical,
  };
}
