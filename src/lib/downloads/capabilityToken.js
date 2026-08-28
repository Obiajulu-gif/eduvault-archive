import { createHmac, timingSafeEqual } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

/**
 * Signed, expiring download capability tokens (#675).
 *
 * The previous implementation (inline in app/api/download/route.js) was a
 * plain base64(JSON) payload with no signature — explicitly commented as a
 * stopgap ("here we base64-encode the structured payload for
 * transparency"). Anyone could tamper with the byte range, buyer, or expiry
 * fields client-side since nothing verified the payload hadn't been
 * modified. This mirrors the HMAC pattern already used for unsubscribe
 * tokens (lib/email/unsubscribeToken.js) and webhook signatures
 * (lib/webhooks/sender.js), using timingSafeEqual for the comparison like
 * the webhook signer does, rather than a plain `!==` string compare.
 */

const CAPABILITY_TOKEN_SECRET =
  process.env.DOWNLOAD_CAPABILITY_SECRET || process.env.JWT_SECRET || 'changeme-in-production';

// A capability grants access to one (buyer, material, byte range) tuple for
// a short window — long enough for the client to actually start the
// download, short enough that a leaked URL (referrer header, browser
// history, proxy log) stops working quickly.
export const CAPABILITY_TTL_MS = Number(process.env.CAPABILITY_TTL_MS || 15_000);

// Maximum bytes a single capability can serve (prevents quota bypass).
export const CAPABILITY_MAX_BYTES = Number(process.env.CAPABILITY_MAX_BYTES || 10_000_000); // 10MB

function sign(payload) {
  return createHmac('sha256', CAPABILITY_TOKEN_SECRET).update(payload).digest('hex');
}

function signaturesMatch(expectedHex, receivedHex) {
  if (typeof receivedHex !== 'string') return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(receivedHex, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Issue a signed capability token bound to buyer, material, and byte range
 * quota. The signature covers the full payload, so a client cannot alter
 * any field (byte range, expiry, buyer) without invalidating the token.
 */
export function generateCapabilityToken({ buyer, material, byteRangeStart, byteRangeEnd, nonce }) {
  const issuedAtMs = Date.now();
  const payload = {
    buyer,
    material,
    byteRangeStart,
    byteRangeEnd,
    byteRangeQuota: byteRangeEnd !== null && byteRangeEnd !== undefined ? byteRangeEnd - byteRangeStart + 1 : undefined,
    nonce: nonce || uuidv4(),
    iat: issuedAtMs,
    exp: issuedAtMs + CAPABILITY_TTL_MS,
    jti: uuidv4(),
  };

  const payloadJson = JSON.stringify(payload);
  const signature = sign(payloadJson);
  const token = Buffer.from(JSON.stringify({ payload: payloadJson, signature })).toString('base64url');

  return { token, payload };
}

/**
 * Verify a capability token's signature, expiry, and identity binding.
 * Returns the decoded payload on success, or `{ valid: false, reason }` on
 * any failure — the reason is for audit logging, never surfaced to the
 * client as anything more specific than a generic 403/410.
 */
export function verifyCapabilityToken(token, { buyerAddress, materialId } = {}) {
  if (!token) return { valid: false, reason: 'missing_token' };

  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
  } catch {
    return { valid: false, reason: 'malformed_token' };
  }

  const { payload: payloadJson, signature } = envelope;
  if (typeof payloadJson !== 'string' || typeof signature !== 'string') {
    return { valid: false, reason: 'malformed_token' };
  }

  if (!signaturesMatch(sign(payloadJson), signature)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { valid: false, reason: 'malformed_payload' };
  }

  if (buyerAddress !== undefined && payload.buyer !== buyerAddress) {
    return { valid: false, reason: 'buyer_mismatch' };
  }
  if (materialId !== undefined && payload.material !== materialId) {
    return { valid: false, reason: 'material_mismatch' };
  }
  if (!payload.nonce) {
    return { valid: false, reason: 'missing_nonce' };
  }

  const requestedBytes =
    payload.byteRangeEnd !== undefined && payload.byteRangeEnd !== null
      ? payload.byteRangeEnd - payload.byteRangeStart + 1
      : payload.byteRangeQuota;
  if (payload.byteRangeQuota !== undefined && requestedBytes > payload.byteRangeQuota) {
    return { valid: false, reason: 'byte_range_quota_exceeded' };
  }
  if (requestedBytes !== undefined && requestedBytes > CAPABILITY_MAX_BYTES) {
    return { valid: false, reason: 'byte_range_exceeds_max' };
  }

  const now = Date.now();
  if (typeof payload.iat !== 'number' || payload.iat > now + 60_000) {
    return { valid: false, reason: 'future_dated' };
  }
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}
