import crypto from "crypto";
import jwt from "jsonwebtoken";
import { getDb } from "@/lib/mongodb";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_TOKEN_HASH_ALGO = "sha256";

function hashRefreshToken(token) {
  return crypto.createHash(REFRESH_TOKEN_HASH_ALGO).update(token, "utf8").digest("hex");
}

/**
 * Sign a short-lived JWT access token (15 min).
 */
export function generateAccessToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return jwt.sign(payload, secret, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

/**
 * Generate a cryptographically secure opaque refresh token.
 */
export function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

/**
 * Persist a refresh token in the database, associated with a user.
 */
export async function storeRefreshToken(userId, token, { familyId, deviceInfo } = {}) {
  const db = await getDb();
  const tokenHash = hashRefreshToken(token);
  const family = familyId || crypto.randomUUID();

  await db.collection("refresh_tokens").insertOne({
    userId: String(userId),
    familyId: family,
    tokenHash,
    deviceInfo: deviceInfo || null,
    used: false,
    revoked: false,
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });

  return family;
}

export async function revokeRefreshTokenFamilyByFamilyId(familyId, userId) {
  const db = await getDb();
  const filter = { familyId };
  if (userId) filter.userId = String(userId);
  await db.collection("refresh_tokens").updateMany(filter, {
    $set: { revoked: true, revokedAt: new Date() },
  });
}

export async function revokeRefreshTokenFamilyByToken(token, userId) {
  const db = await getDb();
  const tokenHash = hashRefreshToken(token);
  const doc = await db.collection("refresh_tokens").findOne({ tokenHash });
  if (!doc) return;
  await revokeRefreshTokenFamilyByFamilyId(doc.familyId, userId);
}

export async function revokeRefreshTokensForUser(userId) {
  const db = await getDb();
  await db.collection("refresh_tokens").updateMany(
    { userId: String(userId), revoked: false },
    { $set: { revoked: true, revokedAt: new Date() } }
  );
}

export async function rotateRefreshToken(oldToken) {
  const db = await getDb();
  const tokenHash = hashRefreshToken(oldToken);
  const doc = await db.collection("refresh_tokens").findOne({ tokenHash });

  if (!doc) return null;

  if (doc.revoked || doc.used) {
    await revokeRefreshTokenFamilyByFamilyId(doc.familyId, doc.userId);
    return null;
  }

  if (doc.expiresAt < new Date()) {
    await db.collection("refresh_tokens").updateOne(
      { _id: doc._id },
      { $set: { revoked: true, revokedAt: new Date() } }
    );
    return null;
  }

  const now = new Date();
  const result = await db.collection("refresh_tokens").updateOne(
    { _id: doc._id, used: false, revoked: false },
    { $set: { used: true, lastUsedAt: now } }
  );

  if (result.modifiedCount !== 1) {
    await revokeRefreshTokenFamilyByFamilyId(doc.familyId, doc.userId);
    return null;
  }

  const newToken = generateRefreshToken();
  await storeRefreshToken(doc.userId, newToken, {
    familyId: doc.familyId,
    deviceInfo: doc.deviceInfo,
  });

  return { userId: doc.userId, refreshToken: newToken, familyId: doc.familyId };
}

export async function listRefreshTokenSessions(userId) {
  const db = await getDb();
  const tokens = await db
    .collection("refresh_tokens")
    .find({ userId: String(userId) })
    .sort({ createdAt: -1 })
    .toArray();

  return tokens.map((token) => ({
    familyId: token.familyId,
    deviceInfo: token.deviceInfo,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    expiresAt: token.expiresAt,
    used: token.used,
    revoked: token.revoked,
  }));
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
