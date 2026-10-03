/**
 * Signing helpers for EduVault.
 *
 * Every signed payload must go through the canonical serialization in
 * `src/lib/canonical.js` so that equivalent inputs produce identical
 * signatures. This module exposes the high-level API used by the auth
 * challenge and marketplace flows.
 *
 * The design is deliberately small and dependency-free:
 *
 *   - `createCanonicalPayload` builds the object that will be signed.
 *   - `canonicalizePayload` returns the byte-stable string that is hashed
 *     or signed.
 *   - `createSigningDigest` produces a stable digest using WebCrypto.
 *   - `signatureMatches` compares two signatures in a constant-time way.
 *
 * The module is pure and testable; it does not touch the network or the
 * database.
 */

import {
  CANONICAL_VERSION,
  CanonicalizationError,
  canonicalBytes,
  canonicalize,
  isCanonicallyEqual,
  normalizeLegacyRecord,
  normalizePayload,
  normalizeString,
} from "./canonical.js";

export { CANONICAL_VERSION, CanonicalizationError, canonicalize, isCanonicallyEqual };

/** The default digest algorithm used for signing digests. */
export const SIGNING_DIGEST_ALGORITHM = "SHA-256";

/** The default domain separator for EduVault signatures. */
export const SIGNING_DOMAIN = "eduvault";

/**
 * Build the canonical payload object for a signing operation.
 *
 * The result is a plain object with a version tag and a domain tag so
 * that signatures cannot be replayed across different contexts. The `body`
 * is normalized and the complete object is returned in canonical form.
 */
export function createCanonicalPayload(body, options = {}) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new CanonicalizationError("Signing body must be a plain object");
  }

  const {
    domain = SIGNING_DOMAIN,
    version = CANONICAL_VERSION,
    sortArrays = false,
    dropUndefined = false,
  } = options;

  const normalizedBody = normalizePayload(body, { sortArrays, dropUndefined });

  return normalizePayload(
    {
      domain: normalizeString(domain),
      version: normalizeString(version),
      body: normalizedBody,
    },
    { sortArrays, dropUndefined }
  );
}

/**
 * Return the canonical string representation of a signing payload.
 */
export function canonicalizePayload(body, options = {}) {
  return canonicalize(createCanonicalPayload(body, options), options);
}

/**
 * Return the UTF-8 bytes of the canonical signing payload. These bytes
 * are what should be hashed or signed.
 */
export function canonicalPayloadBytes(body, options = {}) {
  return canonicalBytes(createCanonicalPayload(body, options), options);
}

/**
 * Create a deterministic digest for a signing payload.
 *
 * Uses WebCrypto when available (Node 18 + browsers) and falls back to
 * Node's `crypto` module otherwise. The function is async so the caller
 * can await it in both egdes and the browser.
 */
export async function createSigningDigest(body, options = {}) {
  const { algorithm = SIGNING_DIGEST_ALGORITHM, } = options;
  const bytes = canonicalPayloadBytes(body, options);

  if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
    const digest = await globalThis.crypto.subtle.digest(algorithm, bytes);
    return Buffer.from(digest).toString("hex");
  }

  const { createHash } = await import("node:crypto");
  return createHash(algorithm.replace("-", "")).update(bytes).digest("hex");
}

/**
 * Constant-time comparison of two signature strings.
 *
 * The function accepts hex or base64 strings and normalizes casing and
 * whitespace before comparing. The comparison itself is constant-time to
 * avoid leaking information through timing oracles.
 */
export function signatureMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = normalizeSignature(a);
  const right = normalizeSignature(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function normalizeSignature(value) {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

/**
 * Normalize a legacy signed record so it can be compared with new payloads.
 * Returns the canonical string representation of the record's body.
 */
export function canonicalizeLegacyRecord(record, options = {}) {
  const normalized = normalizeLegacyRecord(record, options);
  return canonicalize(normalized, options);
}
