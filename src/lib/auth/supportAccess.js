/**
 * Time-bounded maintainer impersonation / support access.
 *
 * Requirements encoded here (#support-access):
 * - **Scoped**: every session carries an explicit scope list from a fixed
 *   vocabulary (`SUPPORT_SCOPES`); guards check `hasSupportScope`.
 * - **Time-bounded**: TTL is clamped to [5 min, 60 min]; `expiresAt` is
 *   enforced on every validation, and `expireSupportSessions()` provides a
 *   cron-able sweep for status hygiene.
 * - **User-safe notices**: `buildSupportNotice` / `toUserSafeNotice` expose
 *   what a user needs to see (scopes, window, reason) without internals
 *   (token hash, actor identifiers).
 * - **Cannot bypass audit logging**: session creation records
 *   `support.access_started` in the immutable hash-chained `audit_ledger`
 *   *before* the session row is inserted, and every guarded request records
 *   `support.access_used` *before* the action proceeds. If the audit append
 *   fails, creation throws and guarded requests fail closed (503) — an
 *   un-auditable support action must never happen.
 * - The bearer token is generated once, returned to the caller, and only its
 *   SHA-256 hash is persisted; it is never written to logs or audit records.
 */

import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { COLLECTIONS } from "../backend/schemaContracts.js";
import { appendAuditRecord } from "../backend/auditLedger.js";
import { isSuspendedUser } from "./suspension.js";

export const SUPPORT_SESSION_COOKIE = "support_session";
export const SUPPORT_SESSION_DEFAULT_TTL_MS = 30 * 60 * 1000;
export const SUPPORT_SESSION_MIN_TTL_MS = 5 * 60 * 1000;
export const SUPPORT_SESSION_MAX_TTL_MS = 60 * 60 * 1000;

export const SUPPORT_SCOPES = Object.freeze({
  READ: "read",
  BILLING: "billing",
  REFUNDS: "refunds",
  MODERATION: "moderation",
});

export const SUPPORT_SESSION_STATUSES = Object.freeze({
  ACTIVE: "active",
  REVOKED: "revoked",
  EXPIRED: "expired",
});

export const SUPPORT_AUDIT_ACTIONS = Object.freeze({
  STARTED: "support.access_started",
  USED: "support.access_used",
  REVOKED: "support.access_revoked",
  EXPIRED: "support.access_expired",
});

function supportError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toDate(value, fallback) {
  if (value instanceof Date) return value;
  const parsed = new Date(value ?? fallback);
  return Number.isNaN(parsed.getTime()) ? new Date(fallback) : parsed;
}

export function hashSupportToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function clampSupportTtl(ttlMs) {
  const numeric = Number(ttlMs);
  if (!Number.isFinite(numeric) || numeric <= 0) return SUPPORT_SESSION_DEFAULT_TTL_MS;
  return Math.min(SUPPORT_SESSION_MAX_TTL_MS, Math.max(SUPPORT_SESSION_MIN_TTL_MS, Math.floor(numeric)));
}

export function normalizeSupportScopes(scopes) {
  if (scopes === undefined || scopes === null) return [SUPPORT_SCOPES.READ];
  const list = Array.isArray(scopes) ? scopes : [scopes];
  const known = new Set(Object.values(SUPPORT_SCOPES));
  const normalized = [...new Set(list.map((scope) => String(scope).trim().toLowerCase()).filter((scope) => known.has(scope)))];
  if (!normalized.length) {
    throw supportError(`At least one valid support scope is required (${[...known].join(", ")}).`, "invalid_support_scopes");
  }
  return normalized;
}

export function sanitizeSupportReason(reason, { maxLength = 500 } = {}) {
  const cleaned = String(reason ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
  if (!cleaned) throw supportError("A non-empty reason is required for support access.", "support_reason_required");
  return cleaned;
}

export function hasSupportScope(session, scope) {
  if (!session) return false;
  if (!scope) return true;
  return Array.isArray(session.scopes) && session.scopes.includes(String(scope));
}

/** User-facing notice for a session (also returned to the maintainer who created it). */
export function buildSupportNotice(session, { now = new Date() } = {}) {
  const currentTime = typeof now === "function" ? now() : toDate(now, new Date());
  const expiresAt = toDate(session.expiresAt, currentTime);
  const createdAt = toDate(session.createdAt, currentTime);
  const remainingMinutes = Math.max(0, Math.round((expiresAt.getTime() - currentTime.getTime()) / 60_000));
  return {
    kind: "support_access_notice",
    message:
      `EduVault support has temporary access to your account (scopes: ${(session.scopes || []).join(", ")}). ` +
      `It started at ${createdAt.toISOString()} and expires at ${expiresAt.toISOString()} (about ${remainingMinutes} minute(s) left).`,
    scopes: session.scopes || [],
    reason: session.reason || null,
    startedAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    expiresInMinutes: remainingMinutes,
  };
}

/** Strips internals (token hash, actor id/wallet) from a session for user display. */
export function toUserSafeNotice(session) {
  return {
    sessionId: String(session._id),
    status: session.status,
    scopes: session.scopes || [],
    reason: session.reason || null,
    startedAt: toDate(session.createdAt, new Date()).toISOString(),
    expiresAt: toDate(session.expiresAt, new Date()).toISOString(),
    lastUsedAt: session.lastUsedAt ? toDate(session.lastUsedAt, new Date()).toISOString() : null,
    useCount: Number(session.useCount || 0),
  };
}

function actorIdOf(actor) {
  return String(actor?.id || actor?.sub || "");
}

async function findUser(db, userId) {
  const query = ObjectId.isValid(userId) ? { _id: new ObjectId(userId) } : { _id: userId };
  return db.collection(COLLECTIONS.users).findOne(query);
}

/**
 * Create a scoped, time-bounded support session.
 *
 * The audit record is appended before the session exists anywhere else; if it
 * fails, creation fails. Returns `{ session, token, notice }` — the raw token
 * is only ever available here.
 */
export async function createSupportSession({
  db,
  actor,
  targetUserId,
  reason,
  scopes,
  ttlMs,
  now = () => new Date(),
  audit = appendAuditRecord,
  tokenFactory,
} = {}) {
  if (!db) throw supportError("createSupportSession requires a db handle", "db_required");
  if (!actor || actor.role !== "admin") {
    throw supportError("Only admins may start a support session.", "not_admin");
  }
  const actorId = actorIdOf(actor);
  if (!actorId) throw supportError("Support actor identity is required.", "actor_required");
  if (!targetUserId) throw supportError("targetUserId is required.", "target_required");
  if (String(targetUserId) === actorId) {
    throw supportError("Maintainers cannot impersonate themselves.", "self_target_forbidden");
  }

  const target = await findUser(db, targetUserId);
  if (!target) throw supportError("Target user not found.", "target_not_found");
  if (isSuspendedUser(target)) {
    throw supportError("Cannot start support access for a suspended account.", "target_suspended");
  }

  const cleanReason = sanitizeSupportReason(reason);
  const sessionScopes = normalizeSupportScopes(scopes);
  const ttl = clampSupportTtl(ttlMs);

  const token = tokenFactory ? tokenFactory() : crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSupportToken(token);
  const sessionId = crypto.randomUUID();
  const createdAt = toDate(now(), new Date());
  const expiresAt = new Date(createdAt.getTime() + ttl);

  // Audit FIRST (fail closed): an un-auditable support session must not exist.
  const auditRecord = await audit({
    db,
    operationId: `support-start:${sessionId}`,
    actor: actorId,
    actorContext: { role: "admin", walletAddress: actor.walletAddress || null, via: "support-session" },
    action: SUPPORT_AUDIT_ACTIONS.STARTED,
    target: { type: "user", id: String(targetUserId) },
    intent: { scopes: sessionScopes, ttlMs: ttl, reason: cleanReason },
    result: { sessionId, expiresAt: expiresAt.toISOString(), targetUserId: String(targetUserId) },
    reason: cleanReason,
  });

  const session = {
    _id: sessionId,
    tokenHash,
    status: SUPPORT_SESSION_STATUSES.ACTIVE,
    actorId,
    actorWallet: actor.walletAddress || null,
    targetUserId: String(targetUserId),
    targetWallet: target.walletAddress || target.walletAddressLower || null,
    scopes: sessionScopes,
    reason: cleanReason,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    lastUsedAt: null,
    useCount: 0,
    schemaVersion: 1,
    auditSequence: auditRecord?.sequence ?? null,
  };

  try {
    await db.collection(COLLECTIONS.supportSessions).insertOne(session);
  } catch (error) {
    // The ledger keeps the intent record; the caller sees a hard failure and
    // can retry (a new sessionId is generated per attempt).
    throw supportError(`Support session could not be persisted: ${error?.message || error}`, "session_persist_failed");
  }

  return { session, token, notice: buildSupportNotice(session, { now: createdAt }) };
}

/**
 * Resolve a bearer token into an active support context, or `null`.
 *
 * Expired sessions are lazily marked expired; revoked/expired/non-admin
 * sessions never resolve.
 */
export async function resolveSupportSession({
  db,
  token,
  now = () => new Date(),
  audit = appendAuditRecord,
  requireAdminActor = true,
} = {}) {
  if (!db || !token) return null;
  const session = await db.collection(COLLECTIONS.supportSessions).findOne({ tokenHash: hashSupportToken(token) });
  if (!session || session.status !== SUPPORT_SESSION_STATUSES.ACTIVE) return null;

  const currentTime = toDate(now(), new Date());
  if (toDate(session.expiresAt, currentTime).getTime() <= currentTime.getTime()) {
    await markSessionExpired({ db, session, now: currentTime, audit }).catch(() => {});
    return null;
  }

  if (requireAdminActor) {
    const actorUser = await findUser(db, session.actorId);
    if (!actorUser || actorUser.role !== "admin" || isSuspendedUser(actorUser)) return null;
  }

  return {
    sessionId: String(session._id),
    actorId: session.actorId,
    targetUserId: session.targetUserId,
    scopes: session.scopes || [],
    reason: session.reason || null,
    status: session.status,
    createdAt: toDate(session.createdAt, currentTime),
    expiresAt: toDate(session.expiresAt, currentTime),
  };
}

async function markSessionExpired({ db, session, now, audit = appendAuditRecord }) {
  const result = await db.collection(COLLECTIONS.supportSessions).updateOne(
    { _id: session._id, status: SUPPORT_SESSION_STATUSES.ACTIVE },
    { $set: { status: SUPPORT_SESSION_STATUSES.EXPIRED, expiredAt: now, updatedAt: now } },
  );
  if (result?.modifiedCount === 0) return null;
  await audit({
    db,
    operationId: `support-expire:${session._id}`,
    actor: "system",
    action: SUPPORT_AUDIT_ACTIONS.EXPIRED,
    target: { type: "user", id: session.targetUserId },
    intent: { sessionId: String(session._id) },
    result: { sessionId: String(session._id), expiredAt: now.toISOString() },
    reason: "ttl_elapsed",
  });
  return session._id;
}

/**
 * Record a *use* of an active support session. Must be awaited before the
 * guarded action proceeds; a failed audit append is a hard failure upstream.
 */
export async function recordSupportUse({
  db,
  session,
  resource = null,
  now = () => new Date(),
  audit = appendAuditRecord,
} = {}) {
  if (!db || !session?.sessionId) throw supportError("recordSupportUse requires a db and session", "session_required");
  const currentTime = toDate(now(), new Date());
  await db.collection(COLLECTIONS.supportSessions).updateOne(
    { _id: session.sessionId, status: SUPPORT_SESSION_STATUSES.ACTIVE },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: currentTime, updatedAt: currentTime } },
  );
  return audit({
    db,
    operationId: `support-use:${session.sessionId}:${crypto.randomUUID()}`,
    actor: session.actorId,
    action: SUPPORT_AUDIT_ACTIONS.USED,
    target: { type: "user", id: session.targetUserId },
    intent: { sessionId: session.sessionId, resource },
    result: { sessionId: session.sessionId, resource, at: currentTime.toISOString() },
    reason: null,
  });
}

function parseSupportCookie(request) {
  const cookieHeader = request?.headers?.get?.("cookie") || "";
  const match = cookieHeader.match(new RegExp(`${SUPPORT_SESSION_COOKIE}=([^;]+)`));
  if (match) return decodeURIComponent(match[1]);
  return request?.headers?.get?.("x-support-session") || null;
}

/**
 * Guard for admin tooling that wants to act *as* a target user.
 *
 * Returns `{ ok: true, session }` only after the access has been written to
 * the audit ledger. Failures:
 *   - 401: no/invalid/expired/revoked session
 *   - 403: session lacks the requested scope (or the actor is no longer admin)
 *   - 503: audit append failed — fail closed rather than act un-audited
 */
export async function requireSupportAccess({
  db,
  request,
  scope = null,
  token = null,
  resource = null,
  now = () => new Date(),
  audit = appendAuditRecord,
} = {}) {
  const bearer = token || parseSupportCookie(request);
  if (!bearer) return { ok: false, status: 401, error: "Support session is required." };

  const session = await resolveSupportSession({ db, token: bearer, now, audit });
  if (!session) return { ok: false, status: 401, error: "Support session is missing, expired, or revoked." };
  if (!hasSupportScope(session, scope)) {
    return { ok: false, status: 403, error: `Support session lacks the "${scope}" scope.`, session };
  }

  try {
    await recordSupportUse({ db, session, resource: resource || scope, now, audit });
  } catch (error) {
    return { ok: false, status: 503, error: "Support access audit unavailable — refusing to proceed.", session };
  }

  return { ok: true, session };
}

/** Revoke an active session. Idempotent per session (repeat revokes are rejected, not re-audited). */
export async function revokeSupportSession({
  db,
  sessionId,
  revokedBy,
  reason = null,
  now = () => new Date(),
  audit = appendAuditRecord,
} = {}) {
  if (!db || !sessionId) throw supportError("revokeSupportSession requires db and sessionId", "session_required");
  if (!revokedBy) throw supportError("revokedBy is required", "revoker_required");

  const session = await db.collection(COLLECTIONS.supportSessions).findOne({ _id: sessionId });
  if (!session) return { ok: false, error: "not_found" };
  if (session.status !== SUPPORT_SESSION_STATUSES.ACTIVE) return { ok: false, error: "not_active", session };

  const currentTime = toDate(now(), new Date());
  const cleanReason = reason ? sanitizeSupportReason(reason) : null;
  await db.collection(COLLECTIONS.supportSessions).updateOne(
    { _id: sessionId, status: SUPPORT_SESSION_STATUSES.ACTIVE },
    {
      $set: {
        status: SUPPORT_SESSION_STATUSES.REVOKED,
        revokedAt: currentTime,
        revokedBy: String(revokedBy),
        revokeReason: cleanReason,
        updatedAt: currentTime,
      },
    },
  );

  const updated = await db.collection(COLLECTIONS.supportSessions).findOne({ _id: sessionId });
  await audit({
    db,
    operationId: `support-revoke:${sessionId}`,
    actor: String(revokedBy),
    action: SUPPORT_AUDIT_ACTIONS.REVOKED,
    target: { type: "user", id: session.targetUserId },
    intent: { sessionId: String(sessionId), reason: cleanReason },
    result: { sessionId: String(sessionId), revokedAt: currentTime.toISOString() },
    reason: cleanReason,
  });

  return { ok: true, session: updated };
}

/**
 * Sweep expired sessions. Cron-able via `npm run support:expire`.
 * One summary audit record is written only when something actually expired.
 */
export async function expireSupportSessions({ db, now = () => new Date(), audit = appendAuditRecord, limit = 200 } = {}) {
  if (!db) throw supportError("expireSupportSessions requires a db handle", "db_required");
  const currentTime = toDate(now(), new Date());

  const candidates = await db
    .collection(COLLECTIONS.supportSessions)
    .find({ status: SUPPORT_SESSION_STATUSES.ACTIVE, expiresAt: { $lte: currentTime } })
    .limit(limit)
    .toArray();

  if (!candidates.length) return { expired: 0, sessionIds: [] };

  const ids = candidates.map((session) => session._id);
  const result = await db.collection(COLLECTIONS.supportSessions).updateMany(
    { _id: { $in: ids }, status: SUPPORT_SESSION_STATUSES.ACTIVE },
    { $set: { status: SUPPORT_SESSION_STATUSES.EXPIRED, expiredAt: currentTime, updatedAt: currentTime } },
  );

  const sessionIds = ids.map(String);
  await audit({
    db,
    operationId: `support-expire-batch:${currentTime.toISOString()}`,
    actor: "system",
    action: SUPPORT_AUDIT_ACTIONS.EXPIRED,
    target: { type: "support_sessions", id: "batch" },
    intent: { limit },
    result: { expired: result?.modifiedCount ?? sessionIds.length, sessionIds },
    reason: "ttl_elapsed",
  });

  return { expired: result?.modifiedCount ?? sessionIds.length, sessionIds };
}
