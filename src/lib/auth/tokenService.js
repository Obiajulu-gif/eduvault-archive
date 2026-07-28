import crypto from "crypto";
import jwt from "jsonwebtoken";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
 * Generate a session family ID for tracking refresh token chains.
 */
function generateSessionFamilyId() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Persist a refresh token in the database, associated with a user and session context.
 */
export async function storeRefreshToken(userId, token, sessionContext = {}) {
  const db = await getDb();
  const sessionFamilyId = sessionContext.familyId || generateSessionFamilyId();

  await db.collection("refresh_tokens").insertOne({
    userId: String(userId),
    token,
    sessionFamilyId,
    used: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    sessionContext: {
      action: sessionContext.action || "default",
      origin: sessionContext.origin || null,
      network: sessionContext.network || null,
      contract: sessionContext.contract || null,
    }
  });

  return sessionFamilyId;
}

/**
 * Rotate a refresh token.
 *
 * - If the token is unknown → return null (reject).
 * - If the token was already used → reuse detected: delete entire session family
 *   and return null (session theft mitigation).
 * - If the token is valid and unused → mark used, issue new token in same family,
 *   return { userId, refreshToken, sessionFamilyId }.
 */
export async function rotateRefreshToken(oldToken, requestedContext = {}) {
  const db = await getDb();
  const doc = await db.collection("refresh_tokens").findOne({ token: oldToken });

  if (!doc) return null;

  // Replay attack — invalidate the entire session family
  if (doc.used) {
    await db.collection("refresh_tokens").deleteMany({ sessionFamilyId: doc.sessionFamilyId });
    return null;
  }

  if (doc.expiresAt < new Date()) {
    await db.collection("refresh_tokens").deleteOne({ _id: doc._id });
    return null;
  }

  const storedContext = doc.sessionContext || {};
  const requestedAction = requestedContext.action || "default";
  const storedAction = storedContext.action || "default";

  if (requestedAction !== storedAction) {
    await db.collection("refresh_tokens").deleteMany({ sessionFamilyId: doc.sessionFamilyId });
    return null;
  }

  // Consume the old token
  await db.collection("refresh_tokens").updateOne({ _id: doc._id }, { $set: { used: true } });

  // Issue a new refresh token in the same family
  const newToken = generateRefreshToken();
  await db.collection("refresh_tokens").insertOne({
    userId: doc.userId,
    token: newToken,
    sessionFamilyId: doc.sessionFamilyId,
    used: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    sessionContext: storedContext,
  });

  return { userId: doc.userId, refreshToken: newToken, sessionFamilyId: doc.sessionFamilyId };
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
