/**
 * Stale Session and Token Revocation System (Issue #1006)
 *
 * Implements deterministic revocation of JWT access tokens and database-backed
 * refresh tokens across security boundary events:
 *   - Account suspension / reactivation
 *   - Role change or administrative privilege alteration
 *   - Wallet recovery / credential rotation
 *   - Replay attack detection on refresh token rotation
 *   - Explicit "Log out from all devices" user requests
 *   - Maintainer impersonation session termination
 *
 * Architecture:
 *   1. User documents maintain a monotonic `sessionVersion` and a `tokensValidAfter` timestamp.
 *   2. Any token signed with `iat < tokensValidAfter` or `sessionVersion < user.sessionVersion`
 *      is rejected as a stale/revoked session.
 *   3. Refresh tokens are tracked in session families. Compromise of any token in a family
 *      triggers total invalidation.
 *   4. Durable audit records are written to `session_revocations` and emitted via `auditLog`.
 */

import { auditLog } from "../api/audit.js";

export const SECURITY_EVENT_TYPES = Object.freeze({
  ACCOUNT_SUSPENDED: "account_suspended",
  ACCOUNT_REACTIVATED: "account_reactivated",
  ROLE_CHANGED: "role_changed",
  WALLET_RECOVERED: "wallet_recovered",
  CREDENTIALS_CHANGED: "credentials_changed",
  TOKEN_REUSE_DETECTED: "token_reuse_detected",
  ALL_SESSIONS_REVOKED: "all_sessions_revoked",
  IMPERSONATION_REVOKED: "impersonation_revoked",
  MANUAL_LOGOUT_ALL: "manual_logout_all",
});

export const REVOCATION_COLLECTION = "session_revocations";

/**
 * Check whether a decoded JWT access token has been revoked by comparing its
 * issuance timestamp and sessionVersion against the user's revocation state.
 *
 * Pure, deterministic evaluation:
 *   - If user has `tokensValidAfter` and `token.iat < tokensValidAfterSec` -> revoked
 *   - If user has `sessionVersion` and `(token.sessionVersion || 1) < user.sessionVersion` -> revoked
 *   - If token contains `sessionFamilyId` present in user's `revokedFamilies` -> revoked
 *   - If token `jti` is in user's `revokedTokenIds` -> revoked
 *
 * @param {object} tokenPayload - Decoded JWT payload
 * @param {object} user - User document from MongoDB
 * @returns {{ revoked: boolean, reason?: string, code?: string }}
 */
export function isSessionRevoked(tokenPayload, user) {
  if (!tokenPayload) {
    return { revoked: true, code: "INVALID_TOKEN", reason: "Missing token payload" };
  }
  if (!user) {
    return { revoked: true, code: "USER_NOT_FOUND", reason: "User does not exist" };
  }

  // 1. Check cutoff timestamp (tokensValidAfter)
  if (user.tokensValidAfter) {
    const validAfterMs = new Date(user.tokensValidAfter).getTime();
    if (!Number.isNaN(validAfterMs)) {
      const validAfterSec = Math.floor(validAfterMs / 1000);
      const tokenIat = Number(tokenPayload.iat);

      if (!Number.isNaN(tokenIat) && tokenIat < validAfterSec) {
        return {
          revoked: true,
          code: "SESSION_REVOKED",
          reason: `Token issued (${tokenIat}) before security event cutoff (${validAfterSec})`,
        };
      }
    }
  }

  // 2. Check monotonic session version counter
  const userSessionVersion = Number(user.sessionVersion || 1);
  const tokenSessionVersion = Number(tokenPayload.sessionVersion || 1);

  if (tokenSessionVersion < userSessionVersion) {
    return {
      revoked: true,
      code: "STALE_SESSION",
      reason: `Token session version (${tokenSessionVersion}) is superseded by user session version (${userSessionVersion})`,
    };
  }

  // 3. Check revoked session family
  if (tokenPayload.sessionFamilyId && Array.isArray(user.revokedFamilies)) {
    if (user.revokedFamilies.includes(tokenPayload.sessionFamilyId)) {
      return {
        revoked: true,
        code: "FAMILY_REVOKED",
        reason: `Session family (${tokenPayload.sessionFamilyId}) has been revoked`,
      };
    }
  }

  // 4. Check specific revoked jti (token identifier)
  if (tokenPayload.jti && Array.isArray(user.revokedTokenIds)) {
    if (user.revokedTokenIds.includes(tokenPayload.jti)) {
      return {
        revoked: true,
        code: "TOKEN_BLACKLISTED",
        reason: `Token ID (${tokenPayload.jti}) is explicitly blacklisted`,
      };
    }
  }

  return { revoked: false };
}

/**
 * Revoke all active sessions and refresh tokens for a user after a security event.
 *
 * @param {object} db - MongoDB database instance
 * @param {string|object} userId - ID of the target user
 * @param {object} options
 * @param {string} options.eventType - One of SECURITY_EVENT_TYPES
 * @param {string} [options.reason] - Human-readable reason for audit logs
 * @param {string} [options.actor] - Identifier of administrator, user, or "system"
 * @param {string} [options.preserveFamilyId] - Optional session family to spare (e.g. current device during "logout others")
 * @param {Date} [options.now] - Injected timestamp for deterministic testing
 * @returns {Promise<{ success: boolean, revokedAt: string, tokensValidAfter: string, sessionVersion: number, refreshTokensRevoked: number }>}
 */
export async function revokeUserSessions(db, userId, options = {}) {
  const {
    eventType = SECURITY_EVENT_TYPES.ALL_SESSIONS_REVOKED,
    reason = "Security event triggered session revocation",
    actor = "system",
    preserveFamilyId = null,
    now = new Date(),
  } = options;

  if (!db) throw new Error("Database connection required");
  if (!userId) throw new Error("userId required for session revocation");

  const timestamp = now instanceof Date ? now : new Date(now);
  const timestampIso = timestamp.toISOString();

  const userIdString = String(userId);

  // Match by id or walletAddress
  const userQuery = {
    $or: [
      { _id: userId },
      { _id: userIdString },
      { walletAddress: userIdString },
    ],
  };

  const usersCollection = db.collection("users");
  const refreshTokensCollection = db.collection("refresh_tokens");
  const revocationsCollection = db.collection(REVOCATION_COLLECTION);

  // 1. Atomically bump user sessionVersion, update tokensValidAfter and record security event
  const userUpdate = {
    $set: {
      tokensValidAfter: timestampIso,
      sessionRevokedAt: timestampIso,
      updatedAt: timestampIso,
      lastSecurityEvent: {
        eventType,
        reason,
        actor,
        at: timestampIso,
      },
    },
    $inc: {
      sessionVersion: 1,
    },
  };

  const updateResult = await usersCollection.findOneAndUpdate(
    userQuery,
    userUpdate,
    { returnDocument: "after" }
  );

  const updatedUser = updateResult?.value || updateResult;
  const newSessionVersion = updatedUser?.sessionVersion || 2;

  // 2. Invalidate refresh tokens
  const tokenQuery = {
    userId: userIdString,
    revoked: { $ne: true },
  };

  if (preserveFamilyId) {
    tokenQuery.sessionFamilyId = { $ne: preserveFamilyId };
  }

  const refreshResult = await refreshTokensCollection.updateMany(
    tokenQuery,
    {
      $set: {
        revoked: true,
        revokedAt: timestamp,
        revocationReason: reason,
        revocationEvent: eventType,
      },
    }
  );

  // 3. Write durable audit record into session_revocations collection
  const revocationRecord = {
    userId: userIdString,
    eventType,
    reason,
    actor,
    revokedAt: timestamp,
    tokensValidAfter: timestampIso,
    sessionVersion: newSessionVersion,
    refreshTokensRevoked: refreshResult?.modifiedCount ?? 0,
    preservedFamilyId: preserveFamilyId || null,
    createdAt: timestamp,
  };

  await revocationsCollection.insertOne(revocationRecord);

  // 4. Emit structured application audit log
  try {
    auditLog({
      event: "security_session_revoked",
      userId: userIdString,
      eventType,
      reason,
      actor,
      tokensValidAfter: timestampIso,
      sessionVersion: newSessionVersion,
      refreshTokensRevoked: refreshResult?.modifiedCount ?? 0,
    });
  } catch {
    // Non-fatal if auditLog is mocked or unavailable
  }

  return {
    success: true,
    revokedAt: timestampIso,
    tokensValidAfter: timestampIso,
    sessionVersion: newSessionVersion,
    refreshTokensRevoked: refreshResult?.modifiedCount ?? 0,
  };
}

/**
 * Revoke an explicit session family (e.g. after refresh token reuse or specific device sign-out).
 */
export async function revokeTokenFamily(db, userId, sessionFamilyId, options = {}) {
  const {
    reason = "Session family revoked",
    actor = "system",
    now = new Date(),
  } = options;

  if (!db) throw new Error("Database connection required");
  if (!userId || !sessionFamilyId) throw new Error("userId and sessionFamilyId required");

  const timestamp = now instanceof Date ? now : new Date(now);
  const userIdString = String(userId);

  // Invalidate all tokens with this family id
  const refreshTokensCollection = db.collection("refresh_tokens");
  const refreshResult = await refreshTokensCollection.updateMany(
    {
      userId: userIdString,
      sessionFamilyId,
    },
    {
      $set: {
        revoked: true,
        revokedAt: timestamp,
        revocationReason: reason,
      },
    }
  );

  const userQuery = {
    $or: [
      { _id: userId },
      { _id: userIdString },
      { walletAddress: userIdString },
    ],
  };

  await db.collection("users").updateOne(
    userQuery,
    {
      $addToSet: { revokedFamilies: sessionFamilyId },
      $set: { updatedAt: timestamp.toISOString() },
    }
  );

  // Durable audit entry
  await db.collection(REVOCATION_COLLECTION).insertOne({
    userId: userIdString,
    sessionFamilyId,
    eventType: SECURITY_EVENT_TYPES.TOKEN_REUSE_DETECTED,
    reason,
    actor,
    revokedAt: timestamp,
    refreshTokensRevoked: refreshResult?.modifiedCount ?? 0,
  });

  try {
    auditLog({
      event: "session_family_revoked",
      userId: userIdString,
      sessionFamilyId,
      reason,
      actor,
    });
  } catch {}

  return {
    success: true,
    sessionFamilyId,
    refreshTokensRevoked: refreshResult?.modifiedCount ?? 0,
  };
}

/**
 * Retrieve recent revocation history for audit and incident triage.
 */
export async function getRevocationHistory(db, userId, { limit = 20 } = {}) {
  if (!db) throw new Error("Database connection required");
  const query = userId ? { userId: String(userId) } : {};
  return db
    .collection(REVOCATION_COLLECTION)
    .find(query)
    .sort({ revokedAt: -1 })
    .limit(limit)
    .toArray();
}
