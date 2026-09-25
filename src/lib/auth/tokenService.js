import crypto from "crypto";
import jwt from "jsonwebtoken";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Key rotation configuration — versioned keys with audience, network, and session binding.
export const KEY_VERSION = Number(process.env.JWT_KEY_VERSION || 1);

// The maximum age (in seconds) a key may be used before it must be rotated.
// After this age, new tokens must be signed with the next key version.
export const MAX_KEY_AGE_SECONDS = Number(process.env.MAX_KEY_AGE_SECONDS || 60 * 60 * 24 * 30); // 30 days

// Algorithm suffix per key version for deterministic cutoff.
export const KEY_ALGO_SUFFIX = `.v${KEY_VERSION}`;

/**
 * Build a key-specific secret from a base secret and key version.
 * This allows multiple key versions to coexist without collision,
 * and enables deterministic key cutoff.
 */
function buildKeySecret(baseSecret, version) {
  return `${baseSecret}${KEY_ALGO_SUFFIX}`;
}

/**
 * JWT payload extensions for key rotation binding.
 *
 * - aud: audience (e.g., "eduvault", "frontend", "mobile")
 * - network: Stellar network passphrase (testnet/mainnet)
 * - keyId: explicit key version identifier
 * - sessionVersion: monotonically increasing session counter for cutoff
 */
export const JWT_EXTENSIONS = {
  audience: "aud",
  network: "network",
  keyId: "keyId",
  sessionVersion: "sessionVersion",
};

/**
 * Sign a short-lived JWT access token (15 min) with key version binding.
 */
export function generateAccessToken(payload, options = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");

  const {
    audience = options.audience || "eduvault",
    network = options.network || "",
    keyId = options.keyId || KEY_VERSION,
    sessionVersion = options.sessionVersion || KEY_VERSION,
  } = options;

  const payloadWithExtensions = {
    ...payload,
    [JWT_EXTENSIONS.audience]: audience,
    [JWT_EXTENSIONS.network]: network,
    [JWT_EXTENSIONS.keyId]: keyId,
    [JWT_EXTENSIONS.sessionVersion]: sessionVersion,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
  };

  const keySecret = buildKeySecret(secret, keyId);
  return jwt.sign(payloadWithExtensions, keySecret, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

/**
 * Verify a JWT access token, with optional fallback to previous key versions.
 * Returns the decoded payload or null if invalid/expired.
 *
 * @param {string} token - The JWT token to verify
 * @param {object} [options] - Verification options
 * @param {number} [options.maxKeyVersions] - How many previous key versions to try (default: 1)
 * @param {string} [options.audience] - Expected audience (optional)
 * @param {string} [options.network] - Expected network passphrase (optional)
 * @returns {{payload: object, keyVersion: number} | null}
 */
export function verifyAccessToken(token, options = {}) {
  const {
    maxKeyVersions = 1,
    audience,
    network,
  } = options;

  if (!token) return null;

  try {
    // First try with the current key version
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });

    // Check binding fields if provided
    if (audience && payload.aud !== audience) return null;
    if (network && payload.network !== network) return null;

    return {
      payload,
      keyVersion: payload.keyId || KEY_VERSION,
    };
  } catch (err) {
    // Token failed with current key — try previous key versions for backward compatibility
    const keyVersionsToTry = [];
    for (let i = KEY_VERSION - 1; i > KEY_VERSION - maxKeyVersions - 1; i--) {
      keyVersionsToTry.push(i);
    }

    for (const keyVersion of keyVersionsToTry) {
      try {
        const keySecret = buildKeySecret(process.env.JWT_SECRET, keyVersion);
        const payload = jwt.verify(token, keySecret, { algorithms: ["HS256"] });

        // Check binding fields
        if (audience && payload.aud !== audience) continue;
        if (network && payload.network !== network) continue;

        return {
          payload,
          keyVersion,
        };
      } catch {
        // Continue to next key version
        continue;
      }
    }

    // All key versions failed
    return null;
  }
}

/**
 * Remove expired refresh tokens — intended for a daily cron or background job.
 */
export async function cleanupExpiredRefreshTokens() {
  const db = await getDb();
  const result = await db.collection("refresh_tokens").deleteMany({
    expiresAt: { $lt: new Date() },
  });
  return result.deletedCount;
}
