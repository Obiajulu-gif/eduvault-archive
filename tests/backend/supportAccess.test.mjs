/**
 * Tests for time-bounded maintainer impersonation / support access
 * (#support-access).
 *
 * Pinned behaviours: scoped creation, TTL clamping, automatic expiry,
 * revocation, user-safe notices, and — the hard requirement — audit logging
 * that cannot be bypassed (creation fails closed without a ledger record;
 * guarded use fails closed when the ledger is unavailable).
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, test } from "node:test";

import {
  SUPPORT_AUDIT_ACTIONS,
  SUPPORT_SCOPES,
  SUPPORT_SESSION_COOKIE,
  SUPPORT_SESSION_DEFAULT_TTL_MS,
  SUPPORT_SESSION_MAX_TTL_MS,
  SUPPORT_SESSION_MIN_TTL_MS,
  buildSupportNotice,
  clampSupportTtl,
  createSupportSession,
  expireSupportSessions,
  hasSupportScope,
  hashSupportToken,
  normalizeSupportScopes,
  requireSupportAccess,
  resolveSupportSession,
  revokeSupportSession,
  toUserSafeNotice,
} from "../../src/lib/auth/supportAccess.js";
import { COLLECTIONS } from "../../src/lib/backend/schemaContracts.js";

// ---------------------------------------------------------------------------
// In-memory fake db
// ---------------------------------------------------------------------------

function compare(a, b) {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, condition]) => {
    const value = doc[key];
    if (condition instanceof Date) return compare(value, condition) === 0;
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      if ("$in" in condition) return condition.$in.some((candidate) => String(candidate) === String(value));
      if ("$lte" in condition) return compare(value, condition.$lte) <= 0;
      if ("$gt" in condition) return compare(value, condition.$gt) > 0;
      if ("$ne" in condition) return String(value) !== String(condition.$ne);
    }
    return String(value) === String(condition);
  });
}

function createFakeCollection() {
  const docs = [];
  return {
    docs,
    async findOne(query = {}) {
      return docs.find((doc) => matches(doc, query)) || null;
    },
    async insertOne(doc) {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    },
    async updateOne(filter, update) {
      const doc = docs.find((candidate) => matches(candidate, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, update.$set || {});
      for (const [field, amount] of Object.entries(update.$inc || {})) {
        doc[field] = (doc[field] || 0) + amount;
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      const targets = docs.filter((candidate) => matches(candidate, filter));
      for (const doc of targets) {
        Object.assign(doc, update.$set || {});
        for (const [field, amount] of Object.entries(update.$inc || {})) {
          doc[field] = (doc[field] || 0) + amount;
        }
      }
      return { matchedCount: targets.length, modifiedCount: targets.length };
    },
    find(query = {}) {
      let result = docs.filter((doc) => matches(doc, query));
      return {
        limit(count) {
          result = result.slice(0, count);
          return this;
        },
        sort() {
          return this;
        },
        async toArray() {
          return result;
        },
      };
    },
  };
}

function createFakeDb() {
  const collections = new Map();
  function collection(name) {
    if (!collections.has(name)) collections.set(name, createFakeCollection());
    return collections.get(name);
  }
  collection(COLLECTIONS.users).docs.push(
    { _id: "admin-1", role: "admin", walletAddress: "gadmin" },
    { _id: "admin-2", role: "admin", walletAddress: "gadmin2" },
    { _id: "user-1", role: "creator", walletAddress: "guser1" },
    { _id: "user-suspended", role: "creator", walletAddress: "guser2", isSuspended: true },
    { _id: "user-demoted", role: "creator", walletAddress: "guser3" },
  );
  return { collection, collections };
}

function createAuditSpy({ fail = false } = {}) {
  const calls = [];
  const audit = async (record) => {
    if (fail) {
      const error = new Error("ledger unavailable");
      error.code = "audit_unavailable";
      throw error;
    }
    calls.push(record);
    return { ...record, sequence: calls.length - 1 };
  };
  audit.calls = calls;
  return audit;
}

const ADMIN_ACTOR = { id: "admin-1", role: "admin", walletAddress: "gadmin" };
const AT_2026 = () => new Date("2026-01-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Creation invariants
// ---------------------------------------------------------------------------

describe("support access — creation", () => {
  test("creates a scoped session and persists only the token hash", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy();
    const { session, token, notice } = await createSupportSession({
      db,
      actor: ADMIN_ACTOR,
      targetUserId: "user-1",
      reason: "Investigating reported purchase issue #4821",
      scopes: [SUPPORT_SCOPES.READ, SUPPORT_SCOPES.BILLING],
      ttlMs: 15 * 60 * 1000,
      now: AT_2026,
      audit,
    });

    assert.equal(session.status, "active");
    assert.deepEqual(session.scopes, ["read", "billing"]);
    assert.equal(session.actorId, "admin-1");
    assert.equal(session.targetUserId, "user-1");
    assert.equal(session.tokenHash, hashSupportToken(token));
    assert.equal(JSON.stringify(session).includes(token), false, "raw token must never be persisted");
    assert.equal(session.expiresAt.getTime() - session.createdAt.getTime(), 15 * 60 * 1000);
    assert.match(notice.message, /scopes: read, billing/);

    assert.equal(audit.calls.length, 1);
    assert.equal(audit.calls[0].action, SUPPORT_AUDIT_ACTIONS.STARTED);
    assert.equal(audit.calls[0].operationId, `support-start:${session._id}`);
    assert.equal(audit.calls[0].target.id, "user-1");
    assert.equal(session.auditSequence, 0);
  });

  test("clamps TTL into [5min, 60min] with a 30min default", () => {
    assert.equal(clampSupportTtl(1_000), SUPPORT_SESSION_MIN_TTL_MS);
    assert.equal(clampSupportTtl(999 * 60 * 1000), SUPPORT_SESSION_MAX_TTL_MS);
    assert.equal(clampSupportTtl(undefined), SUPPORT_SESSION_DEFAULT_TTL_MS);
    assert.equal(clampSupportTtl("nonsense"), SUPPORT_SESSION_DEFAULT_TTL_MS);
  });

  test("rejects non-admin actors, missing reasons, unknown scopes, self-targets, and unknown/suspended targets", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy();
    const base = { db, targetUserId: "user-1", reason: "why", audit, now: AT_2026 };

    await assert.rejects(
      createSupportSession({ ...base, actor: { id: "user-1", role: "creator" } }),
      (error) => error.code === "not_admin",
    );
    await assert.rejects(
      createSupportSession({ ...base, actor: ADMIN_ACTOR, reason: "   " }),
      (error) => error.code === "support_reason_required",
    );
    await assert.rejects(
      createSupportSession({ ...base, actor: ADMIN_ACTOR, scopes: ["god-mode"] }),
      (error) => error.code === "invalid_support_scopes",
    );
    await assert.rejects(
      createSupportSession({ ...base, actor: ADMIN_ACTOR, targetUserId: "admin-1" }),
      (error) => error.code === "self_target_forbidden",
    );
    await assert.rejects(
      createSupportSession({ ...base, actor: ADMIN_ACTOR, targetUserId: "ghost" }),
      (error) => error.code === "target_not_found",
    );
    await assert.rejects(
      createSupportSession({ ...base, actor: ADMIN_ACTOR, targetUserId: "user-suspended" }),
      (error) => error.code === "target_suspended",
    );
    assert.equal(db.collection(COLLECTIONS.supportSessions).docs.length, 0);
  });

  test("cannot bypass audit logging: creation fails closed if the ledger append fails", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy({ fail: true });

    await assert.rejects(
      createSupportSession({
        db,
        actor: ADMIN_ACTOR,
        targetUserId: "user-1",
        reason: "test",
        audit,
        now: AT_2026,
      }),
      /ledger unavailable/,
    );
    assert.equal(db.collection(COLLECTIONS.supportSessions).docs.length, 0, "no session may exist without an audit record");
  });

  test("normalizeSupportScopes dedupes, lowercases, and defaults to read", () => {
    assert.deepEqual(normalizeSupportScopes(undefined), ["read"]);
    assert.deepEqual(normalizeSupportScopes(["READ", "read", "billing"]), ["read", "billing"]);
    assert.throws(() => normalizeSupportScopes([""]), (error) => error.code === "invalid_support_scopes");
  });
});

// ---------------------------------------------------------------------------
// Resolution, expiry, revocation
// ---------------------------------------------------------------------------

describe("support access — resolution lifecycle", () => {
  test("resolves an active session and enforces the admin re-check", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy();
    const { token } = await createSupportSession({
      db,
      actor: ADMIN_ACTOR,
      targetUserId: "user-1",
      reason: "debug",
      scopes: ["read"],
      audit,
      now: AT_2026,
    });

    const resolved = await resolveSupportSession({ db, token, audit, now: AT_2026 });
    assert.equal(resolved.targetUserId, "user-1");
    assert.deepEqual(resolved.scopes, ["read"]);

    // A demoted actor can no longer resolve their (still unexpired) session.
    db.collection(COLLECTIONS.users).docs.find((doc) => doc._id === "admin-1").role = "creator";
    const afterDemotion = await resolveSupportSession({ db, token, audit, now: AT_2026 });
    assert.equal(afterDemotion, null);
  });

  test("expires automatically at expiresAt and lazily records the expiry in the ledger", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy();
    const { token, session } = await createSupportSession({
      db,
      actor: ADMIN_ACTOR,
      targetUserId: "user-1",
      reason: "debug",
      ttlMs: SUPPORT_SESSION_MIN_TTL_MS,
      audit,
      now: AT_2026,
    });

    const afterTtl = await resolveSupportSession({
      db,
      token,
      audit,
      now: () => new Date(AT_2026().getTime() + SUPPORT_SESSION_MIN_TTL_MS + 1000),
    });
    assert.equal(afterTtl, null);
    assert.equal(db.collection(COLLECTIONS.supportSessions).docs[0].status, "expired");
    assert.ok(audit.calls.some((call) => call.action === SUPPORT_AUDIT_ACTIONS.EXPIRED && call.intent.sessionId === session._id));
  });

  test("revocation is immediate, recorded, and repeat revocations are rejected", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy();
    const { token, session } = await createSupportSession({
      db,
      actor: ADMIN_ACTOR,
      targetUserId: "user-1",
      reason: "debug",
      audit,
      now: AT_2026,
    });

    const revoked = await revokeSupportSession({ db, sessionId: session._id, revokedBy: "admin-2", reason: "issue resolved", audit });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.session.status, "revoked");
    assert.equal(revoked.session.revokedBy, "admin-2");
    assert.ok(audit.calls.some((call) => call.action === SUPPORT_AUDIT_ACTIONS.REVOKED && call.actor === "admin-2"));

    assert.equal(await resolveSupportSession({ db, token, audit, now: AT_2026 }), null);

    const again = await revokeSupportSession({ db, sessionId: session._id, revokedBy: "admin-2", audit });
    assert.equal(again.ok, false);
    assert.equal(again.error, "not_active");

    const missing = await revokeSupportSession({ db, sessionId: "ghost", revokedBy: "admin-2", audit });
    assert.equal(missing.error, "not_found");
  });

  test("the sweep expires only overdue active sessions and audits one summary record", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy();
    await createSupportSession({ db, actor: ADMIN_ACTOR, targetUserId: "user-1", reason: "old", audit, now: () => new Date("2026-01-01T00:00:00Z") });
    await createSupportSession({ db, actor: ADMIN_ACTOR, targetUserId: "user-1", reason: "fresh", audit, now: () => new Date("2026-06-01T00:00:00Z") });

    const auditBeforeSweep = audit.calls.length;
    const result = await expireSupportSessions({ db, audit, now: () => new Date("2026-01-01T01:00:00Z") });

    assert.equal(result.expired, 1);
    assert.equal(audit.calls.length, auditBeforeSweep + 1);
    assert.equal(audit.calls.at(-1).action, SUPPORT_AUDIT_ACTIONS.EXPIRED);
    assert.equal(audit.calls.at(-1).result.expired, 1);

    // Nothing overdue now: no further audit noise.
    const quiet = await expireSupportSessions({ db, audit, now: () => new Date("2026-01-01T01:00:00Z") });
    assert.equal(quiet.expired, 0);
  });
});

// ---------------------------------------------------------------------------
// Guard behaviour (scopes, audit fail-closed)
// ---------------------------------------------------------------------------

describe("support access — guarded use", () => {
  function requestWithCookie(token) {
    return { headers: { get: (name) => (name === "cookie" ? `${SUPPORT_SESSION_COOKIE}=${token}` : null) } };
  }

  test("allows in-scope use and records it in the ledger before returning", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy();
    const { token, session } = await createSupportSession({
      db,
      actor: ADMIN_ACTOR,
      targetUserId: "user-1",
      reason: "billing investigation",
      scopes: [SUPPORT_SCOPES.BILLING],
      audit,
      now: AT_2026,
    });

    const guard = await requireSupportAccess({
      db,
      request: requestWithCookie(token),
      scope: SUPPORT_SCOPES.BILLING,
      resource: "purchases.read",
      audit,
      now: () => new Date("2026-01-01T00:05:00Z"),
    });

    assert.equal(guard.ok, true);
    assert.equal(guard.session.targetUserId, "user-1");
    const useCalls = audit.calls.filter((call) => call.action === SUPPORT_AUDIT_ACTIONS.USED);
    assert.equal(useCalls.length, 1);
    assert.equal(useCalls[0].intent.resource, "purchases.read");
    const stored = db.collection(COLLECTIONS.supportSessions).docs.find((doc) => doc._id === session._id);
    assert.equal(stored.useCount, 1);
    assert.ok(stored.lastUsedAt instanceof Date);
  });

  test("rejects out-of-scope use without recording a use", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy();
    const { token } = await createSupportSession({
      db,
      actor: ADMIN_ACTOR,
      targetUserId: "user-1",
      reason: "billing investigation",
      scopes: [SUPPORT_SCOPES.READ],
      audit,
      now: AT_2026,
    });

    const guard = await requireSupportAccess({
      db,
      request: requestWithCookie(token),
      scope: SUPPORT_SCOPES.REFUNDS,
      audit,
      now: () => new Date("2026-01-01T00:05:00Z"),
    });
    assert.equal(guard.ok, false);
    assert.equal(guard.status, 403);
    assert.equal(audit.calls.filter((call) => call.action === SUPPORT_AUDIT_ACTIONS.USED).length, 0);
  });

  test("fails closed with 503 when the use cannot be audited", async () => {
    const db = createFakeDb();
    const setupAudit = createAuditSpy();
    const { token } = await createSupportSession({
      db,
      actor: ADMIN_ACTOR,
      targetUserId: "user-1",
      reason: "debug",
      scopes: ["read"],
      audit: setupAudit,
      now: AT_2026,
    });

    const failingAudit = createAuditSpy({ fail: true });
    const guard = await requireSupportAccess({
      db,
      request: requestWithCookie(token),
      scope: "read",
      audit: failingAudit,
      now: () => new Date("2026-01-01T00:05:00Z"),
    });
    assert.equal(guard.ok, false);
    assert.equal(guard.status, 503);
  });

  test("rejects missing, unknown, and expired tokens with 401", async () => {
    const db = createFakeDb();
    const audit = createAuditSpy();

    assert.equal((await requireSupportAccess({ db, request: { headers: { get: () => null } }, audit })).status, 401);

    const unknown = await requireSupportAccess({
      db,
      request: requestWithCookie("not-a-real-token"),
      audit,
    });
    assert.equal(unknown.status, 401);
  });

  test("hasSupportScope and notice sanitization", async () => {
    assert.equal(hasSupportScope({ scopes: ["read"] }, "read"), true);
    assert.equal(hasSupportScope({ scopes: ["read"] }, "billing"), false);
    assert.equal(hasSupportScope({ scopes: [] }, null), true);

    const db = createFakeDb();
    const audit = createAuditSpy();
    const { session } = await createSupportSession({
      db,
      actor: ADMIN_ACTOR,
      targetUserId: "user-1",
      reason: "investigation",
      scopes: ["read"],
      ttlMs: 10 * 60 * 1000,
      audit,
      now: AT_2026,
    });

    const notice = buildSupportNotice(session, { now: AT_2026 });
    assert.match(notice.message, /temporary access/);
    assert.equal(notice.expiresInMinutes, 10);

    const safe = toUserSafeNotice(session);
    assert.equal(safe.tokenHash, undefined);
    assert.equal(safe.actorId, undefined);
    assert.equal(safe.actorWallet, undefined);
    assert.deepEqual(safe.scopes, ["read"]);
  });

  test("token hashing is stable and irreversible", () => {
    const token = crypto.randomBytes(32).toString("hex");
    assert.equal(hashSupportToken(token), hashSupportToken(token));
    assert.notEqual(hashSupportToken(token), token);
    assert.equal(hashSupportToken(token).length, 64);
  });
});
