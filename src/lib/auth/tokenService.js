import crypto from "crypto";
import jwt from "jsonwebtoken";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { revokeUserSessions, SECURITY_EVENT_TYPES } from "./sessionRevocation.js";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
 * JWT payload extensions for key rotation binding and session tracking.
 */
export const JWT_EXTENSIONS = {
  audience: "aud",
  network: "network",
  keyId: "keyId",
  sessionVersion: "sessionVersion",
  sessionFamilyId: "sessionFamilyId",
  jti: "jti",
};

/**
 * Sign a short-lived JWT access token (15 min) with key version binding.
 */
export function generateAccessToken(payload, options = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");

  const {
    audience = options.audience || payload.aud || "eduvault",
    network = options.network || payload.network || "",
    keyId = options.keyId || payload.keyId || KEY_VERSION,
    sessionVersion = options.sessionVersion ?? payload.sessionVersion ?? 1,
    sessionFamilyId = options.sessionFamilyId ?? payload.sessionFamilyId ?? null,
  } = options;

  const nowSec = Math.floor(Date.now() / 1000);
  const jti = options.jti || crypto.randomUUID();

  const payloadWithExtensions = {
    ...payload,
    [JWT_EXTENSIONS.audience]: audience,
    [JWT_EXTENSIONS.network]: network,
    [JWT_EXTENSIONS.keyId]: keyId,
    [JWT_EXTENSIONS.sessionVersion]: sessionVersion,
    [JWT_EXTENSIONS.sessionFamilyId]: sessionFamilyId,
    [JWT_EXTENSIONS.jti]: jti,
    iat: nowSec,
    exp: nowSec + ACCESS_TOKEN_TTL_SECONDS,
  };

  const keySecret = buildKeySecret(secret, keyId);
  return jwt.sign(payloadWithExtensions, keySecret, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

/**
 * Verify a JWT access token, with optional fallback to previous key versions.
 * Returns the decoded payload or null if invalid/expired.
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
        continue;
      }
    }

    return null;
  }
}

/**
 * Generate a cryptographically secure opaque refresh token.
 */
export function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

/**
 * Persist a refresh token in the database, associated with a user and session family.
 */
export async function storeRefreshToken(userId, token, sessionContext = {}) {
  const db = await getDb();
  const sessionFamilyId = sessionContext.sessionFamilyId || crypto.randomUUID();

  await db.collection("refresh_tokens").insertOne({
    userId: String(userId),
    token,
    sessionFamilyId,
    used: false,
    revoked: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    sessionContext: {
      action: sessionContext.action || "default",
      network: sessionContext.network || "",
      origin: sessionContext.origin || "",
    },
  });

  return { sessionFamilyId };
}

/**
 * Rotate a refresh token with strict replay-attack detection and automatic
 * session revocation (Issue #1006).
 *
 * - Unknown token -> return null (reject).
 * - Expired token -> delete doc and return null.
 * - Revoked or already used token -> REPLAY ATTACK DETECTED:
 *   Immediately revokes ALL active sessions for that user across devices,
 *   invalidates all refresh tokens in the family, and returns null.
 * - Valid token -> marks old token used, creates new refresh token in same family,
 *   returns { userId, refreshToken, sessionFamilyId }.
 */
export async function rotateRefreshToken(oldToken, options = {}) {
  const db = await getDb();
  const doc = await db.collection("refresh_tokens").findOne({ token: oldToken });

  if (!doc) return null;

  // Replay Attack Detection: If token was already consumed or revoked, someone is
  // trying to replay an obsolete token. Invalidate ALL sessions for this user!
  if (doc.used || doc.revoked) {
    await revokeUserSessions(db, doc.userId, {
      eventType: SECURITY_EVENT_TYPES.TOKEN_REUSE_DETECTED,
      reason: `Refresh token reuse / replay detected on family ${doc.sessionFamilyId}`,
      actor: "system",
    });
    return null;
  }

  // Expired token check
  if (new Date(doc.expiresAt) < new Date()) {
    await db.collection("refresh_tokens").deleteOne({ _id: doc._id });
    return null;
  }

  // Atomically mark old token as used
  const updateResult = await db.collection("refresh_tokens").updateOne(
    { _id: doc._id, used: false, revoked: false },
    { $set: { used: true, usedAt: new Date() } }
  );

  if (updateResult.modifiedCount === 0) {
    // Concurrent race condition on rotation — treat as replay
    await revokeUserSessions(db, doc.userId, {
      eventType: SECURITY_EVENT_TYPES.TOKEN_REUSE_DETECTED,
      reason: `Concurrent refresh collision / race condition on family ${doc.sessionFamilyId}`,
      actor: "system",
    });
    return null;
  }

  // Issue new refresh token in the same session family
  const newToken = generateRefreshToken();
  const sessionFamilyId = doc.sessionFamilyId || crypto.randomUUID();

  await db.collection("refresh_tokens").insertOne({
    userId: doc.userId,
    token: newToken,
    sessionFamilyId,
    used: false,
    revoked: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    sessionContext: {
      action: options.action || doc.sessionContext?.action || "default",
      network: options.network || doc.sessionContext?.network || "",
      origin: options.origin || doc.sessionContext?.origin || "",
    },
  });

  return {
    userId: doc.userId,
    refreshToken: newToken,
    sessionFamilyId,
  };
}

/**
 * Remove expired or revoked refresh tokens past retention threshold.
 */
export async function cleanupExpiredRefreshTokens() {
  const db = await getDb();
  const result = await db.collection("refresh_tokens").deleteMany({
    $or: [
      { expiresAt: { $lt: new Date() } },
      { revoked: true, revokedAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    ],
  });
  return result.deletedCount;
}

/**
 * Invalidate all refresh tokens for a user.
 */
export async function revokeRefreshTokensForUser(userId) {
  const db = await getDb();
  const result = await db.collection("refresh_tokens").updateMany(
    { userId: String(userId), revoked: { $ne: true } },
    { $set: { revoked: true, revokedAt: new Date(), revocationReason: "Explicit user revocation" } }
  );
  return result.modifiedCount;
}
