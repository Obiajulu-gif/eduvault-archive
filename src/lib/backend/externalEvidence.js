import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { canonicalizePayload } from "../signing.js";

export const EXTERNAL_EVIDENCE_VERSION = "1";
const SUPPORTED_ALGORITHMS = new Set(["ed25519", "ed448"]);

export function canonicalExternalEvidencePayload(evidence) {
  const { signature: _signature, ...unsigned } = evidence ?? {};
  return canonicalizePayload(unsigned, { domain: "eduvault.external-evidence", version: EXTERNAL_EVIDENCE_VERSION });
}

export function evidenceDigest(evidence) {
  return createHash("sha256").update(canonicalExternalEvidencePayload(evidence)).digest("hex");
}

export function verifyExternalEvidence(evidence, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!evidence || typeof evidence !== "object") return { valid: false, reason: "invalid-envelope" };
  if (!evidence.evidenceId || typeof evidence.signature !== "string" || !evidence.publicKey) {
    return { valid: false, reason: "missing-signature-fields" };
  }
  const algorithm = evidence.algorithm ?? "ed25519";
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) return { valid: false, reason: "unsupported-algorithm" };
  const issuedAt = Date.parse(evidence.issuedAt);
  if (!Number.isFinite(issuedAt) || issuedAt > now || now - issuedAt > maxAgeMs) return { valid: false, reason: "stale-evidence" };
  if (evidence.expiresAt && Date.parse(evidence.expiresAt) < now) return { valid: false, reason: "expired-evidence" };

  let valid = false;
  try {
    valid = verifySignature(null, Buffer.from(canonicalExternalEvidencePayload(evidence)), createPublicKey(evidence.publicKey), Buffer.from(evidence.signature, "base64"));
  } catch {
    return { valid: false, reason: "malformed-signature" };
  }
  return valid ? { valid: true, digest: evidenceDigest(evidence), algorithm } : { valid: false, reason: "signature-mismatch" };
}

export function assertExternalEvidence(evidence, options = {}) {
  const result = verifyExternalEvidence(evidence, options);
  if (!result.valid) {
    const error = new Error(`External evidence verification failed: ${result.reason}`);
    error.code = "INVALID_EXTERNAL_EVIDENCE";
    throw error;
  }
  return result;
}
