/**
 * Delivery Token Service
 *
 * Issues and verifies short-lived, audience-bound access tokens for
 * authenticated streaming delivery. Tokens are bound to:
 *   - The authenticated account (buyerAddress)
 *   - The material being accessed (materialId)
 *   - An expiry timestamp (max 15 minutes)
 *   - An optional single-use nonce (prevents replay)
 *
 * Tokens are HMAC-signed with a server-side secret so they can be verified
 * without a database round-trip (except for single-use nonce revocation).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '@/lib/mongodb';

const TOKEN_VERSION = 1;
const DEFAULT_TTL_SECONDS = 15 * 60; // 15 minutes
const MAX_TTL_SECONDS = 60 * 60; // 1 hour absolute max

/**
 * Get the HMAC signing key from environment, or derive one from JWT_SECRET.
 */
function getSigningKey() {
  const key = process.env.DELIVERY_HMAC_SECRET || process.env.JWT_SECRET;
  if (!key) {
    throw new Error(
      'DELIVERY_HMAC_SECRET or JWT_SECRET must be set for delivery token signing'
    );
  }
  return key;
}

/**
 * Generate a delivery token bound to a specific account, material, and expiry.
 *
 * @param {object} params
 * @param {string} params.buyerAddress - The authenticated buyer's Stellar public key
 * @param {string} params.materialId - The material identifier
 * @param {number} [params.ttlSeconds] - Token time-to-live in seconds (default 900, max 3600)
 * @param {boolean} [params.singleUse] - If true, a nonce is embedded and tracked for single-use
 * @param {string} [params.ipRestriction] - Optional client IP for additional binding
 * @returns {Promise<{token: string, expiresAt: number, nonce: string|null}>}
 */
export async function issueDeliveryToken({
  buyerAddress,
  materialId,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  singleUse = false,
  ipRestriction = null,
}) {
  if (!buyerAddress || !materialId) {
    throw new Error('buyerAddress and materialId are required');
  }

  const ttl = Math.min(Math.max(1, ttlSeconds), MAX_TTL_SECONDS);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttl;
  const nonce = singleUse ? randomBytes(16).toString('hex') : null;

  const payload = {
    v: TOKEN_VERSION,
    ba: buyerAddress.toLowerCase(),
    mi: materialId,
    ia: issuedAt,
    ea: expiresAt,
    nu: nonce,
    ir: ipRestriction || null,
  };

  const signed = await signToken(payload);

  // If single-use, persist the nonce so we can revoke it after first use
  if (singleUse && nonce) {
    const db = await getDb();
    await db.collection('delivery_nonces').insertOne({
      nonce,
      materialId,
      buyerAddress: buyerAddress.toLowerCase(),
      expiresAt: new Date(expiresAt * 1000),
      used: false,
      createdAt: new Date(),
    });
  }

  return { token: signed, expiresAt, nonce };
}

/**
 * Verify a delivery token and return its decoded payload if valid.
 *
 * @param {string} token - The signed token string
 * @param {object} [options]
 * @param {string} [options.expectedBuyer] - If set, verify the token is for this buyer
 * @param {string} [options.expectedMaterial] - If set, verify the token is for this material
 * @param {string} [options.clientIp] - If set, verify the token's IP restriction matches
 * @returns {Promise<{valid: boolean, payload: object|null, reason: string|null}>}
 */
export async function verifyDeliveryToken(token, options = {}) {
  if (!token || typeof token !== 'string') {
    return { valid: false, payload: null, reason: 'missing_token' };
  }

  let payload;
  try {
    payload = await unsignToken(token);
  } catch {
    return { valid: false, payload: null, reason: 'invalid_signature' };
  }

  if (!payload || payload.v !== TOKEN_VERSION) {
    return { valid: false, payload: null, reason: 'unsupported_version' };
  }

  // Check expiry (at or after expiry second)
  const now = Math.floor(Date.now() / 1000);
  if (now >= payload.ea) {
    return { valid: false, payload, reason: 'token_expired' };
  }

  // Check audience binding
  if (options.expectedBuyer) {
    const expected = options.expectedBuyer.toLowerCase();
    if (payload.ba !== expected) {
      return { valid: false, payload, reason: 'buyer_mismatch' };
    }
  }

  if (options.expectedMaterial) {
    if (payload.mi !== options.expectedMaterial) {
      return { valid: false, payload, reason: 'material_mismatch' };
    }
  }

  // Check IP restriction if present in token
  if (payload.ir && options.clientIp) {
    if (payload.ir !== options.clientIp) {
      return { valid: false, payload, reason: 'ip_mismatch' };
    }
  }

  // Check single-use nonce revocation
  if (payload.nu) {
    const db = await getDb();
    const nonceRecord = await db.collection('delivery_nonces').findOne({
      nonce: payload.nu,
    });

    if (!nonceRecord) {
      return { valid: false, payload, reason: 'nonce_not_found' };
    }

    if (nonceRecord.used) {
      return { valid: false, payload, reason: 'nonce_already_used' };
    }

    // Mark as used atomically
    const result = await db.collection('delivery_nonces').updateOne(
      { nonce: payload.nu, used: false },
      { $set: { used: true, usedAt: new Date() } }
    );

    if (result.modifiedCount === 0) {
      return { valid: false, payload, reason: 'nonce_contention' };
    }
  }

  return { valid: true, payload, reason: null };
}

/**
 * Sign a token payload using HMAC-SHA256.
 * Format: base64(payload) . base64(signature)
 */
async function signToken(payload) {
  const key = getSigningKey();
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = createHmac('sha256', key);
  hmac.update(encoded);
  const signature = hmac.digest('base64url');
  return `${encoded}.${signature}`;
}

/**
 * Verify and decode a signed token.
 * Throws on invalid signature or malformed token.
 */
async function unsignToken(token) {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new Error('malformed_token');
  }

  const [encoded, signature] = parts;

  const key = getSigningKey();
  const hmac = createHmac('sha256', key);
  hmac.update(encoded);
  const expectedSig = hmac.digest('base64url');

  // Timing-safe comparison to prevent timing attacks
  const sigBuf = Buffer.from(signature, 'base64url');
  const expectedBuf = Buffer.from(expectedSig, 'base64url');

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('invalid_signature');
  }

  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
}

/**
 * Clean up expired nonces from the database.
 * Should be called periodically (e.g., via a cron job).
 */
export async function cleanExpiredNonces() {
  const db = await getDb();
  const result = await db.collection('delivery_nonces').deleteMany({
    expiresAt: { $lt: new Date() },
  });
  return result.deletedCount;
}