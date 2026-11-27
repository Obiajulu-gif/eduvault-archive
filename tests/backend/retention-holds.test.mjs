/**
 * Retention Holds for Refund & Compliance Investigations Tests
 *
 * Covers normal, failure, retry/idempotency, authorization, and rollback paths.
 * Uses a self-contained in-memory Mongo-compatible DB harness so it runs cleanly
 * with `node --test tests/backend/retention-holds.test.mjs`.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  RETENTION_HOLDS_COLLECTION,
  AUDIT_LEDGER_COLLECTION,
  HOLD_INVESTIGATION_TYPES,
  HOLD_STATUSES,
  createRetentionHold,
  releaseRetentionHold,
  listRetentionHolds,
  buildHoldExclusionFilter,
} from "../../src/lib/privacy/retentionHolds.js";

function matchesFilter(doc, filter = {}) {
  for (const [key, expected] of Object.entries(filter)) {
    const actual = doc[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
      if ("$ne" in expected) {
        if (actual === expected.$ne) return false;
        continue;
      }
    }
    if (Array.isArray(actual)) {
      if (!actual.includes(expected)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function createInMemoryDb({ failUpdateOnId = null } = {}) {
  const stores = new Map();

  function getStore(name) {
    if (!stores.has(name)) stores.set(name, []);
    return stores.get(name);
  }

  return {
    collection(name) {
      const store = getStore(name);
      return {
        async insertOne(doc) {
          store.push(structuredClone(doc));
          return { acknowledged: true, insertedId: doc._id || doc.holdId };
        },
        async findOne(filter) {
          const found = store.find((d) => matchesFilter(d, filter));
          return found ? structuredClone(found) : null;
        },
        find(filter = {}) {
          const matched = store.filter((d) => matchesFilter(d, filter)).map((d) => structuredClone(d));
          return {
            async toArray() {
              return matched;
            },
          };
        },
        async updateOne(filter, update) {
          if (failUpdateOnId && filter._id === failUpdateOnId) {
            throw new Error(`Simulated DB write failure on ${failUpdateOnId}`);
          }
          const target = store.find((d) => matchesFilter(d, filter));
          if (!target) return { matchedCount: 0, modifiedCount: 0 };

          if (update.$set) {
            Object.assign(target, structuredClone(update.$set));
          }
          if (update.$addToSet) {
            for (const [field, val] of Object.entries(update.$addToSet)) {
              if (!Array.isArray(target[field])) target[field] = [];
              if (!target[field].includes(val)) target[field].push(val);
            }
          }
          if (update.$pull) {
            for (const [field, val] of Object.entries(update.$pull)) {
              if (Array.isArray(target[field])) {
                target[field] = target[field].filter((item) => item !== val);
              }
            }
          }
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async deleteMany(filter = {}) {
          const before = store.length;
          const remaining = store.filter((d) => !matchesFilter(d, filter));
          stores.set(name, remaining);
          return { deletedCount: before - remaining.length };
        },
      };
    },
  };
}

const ADMIN_ACTOR = { sub: "admin-1", role: "admin", suspended: false };
const NOW = new Date("2026-11-23T00:00:00.000Z");

describe("Retention Holds for Refund and Compliance Investigations", () => {
  let db;

  beforeEach(async () => {
    db = createInMemoryDb();
    await db.collection("download_access_logs").insertOne({
      _id: "log-1",
      buyer: "buyer-1",
      timestamp: new Date("2025-01-01T00:00:00.000Z"),
    });
    await db.collection("download_access_logs").insertOne({
      _id: "log-2",
      buyer: "buyer-2",
      timestamp: new Date("2025-01-01T00:00:00.000Z"),
    });
  });

  describe("Normal paths", () => {
    it("creates a refund investigation retention hold and marks target records", async () => {
      const result = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "REF-2026-001",
          reason: "Buyer dispute over corrupted archive download",
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 201);
      assert.equal(result.idempotent, false);
      assert.equal(result.hold.status, HOLD_STATUSES.ACTIVE);
      assert.deepEqual(result.hold.appliedRecordIds, ["log-1"]);

      const record = await db.collection("download_access_logs").findOne({ _id: "log-1" });
      assert.equal(record.hold, true);
      assert.equal(record.refundPending, true);
      assert.deepEqual(record.retentionHoldIds, [result.hold.holdId]);

      const audits = await db.collection(AUDIT_LEDGER_COLLECTION).find({}).toArray();
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, "RETENTION_HOLD_CREATED");
      assert.equal(audits[0].caseId, "REF-2026-001");
    });

    it("creates a compliance investigation hold with legalHold and auditHold markers", async () => {
      const result = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.COMPLIANCE,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1", "log-2"],
          caseId: "COMP-2026-042",
          reason: "Regulatory audit preservation order",
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, 201);
      assert.deepEqual(result.hold.appliedRecordIds, ["log-1", "log-2"]);

      const record = await db.collection("download_access_logs").findOne({ _id: "log-2" });
      assert.equal(record.hold, true);
      assert.equal(record.legalHold, true);
      assert.equal(record.auditHold, true);

      // Held records must be excluded by buildHoldExclusionFilter
      const cleanupResult = await db
        .collection("download_access_logs")
        .deleteMany(buildHoldExclusionFilter());
      assert.equal(cleanupResult.deletedCount, 0);
    });

    it("lists holds filtered by investigationType and releases a hold cleanly", async () => {
      const created = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "REF-2026-002",
          reason: "Refund review",
        },
      });

      const listed = await listRetentionHolds({
        db,
        actorContext: ADMIN_ACTOR,
        filters: { investigationType: HOLD_INVESTIGATION_TYPES.REFUND },
      });
      assert.equal(listed.ok, true);
      assert.equal(listed.holds.length, 1);

      const released = await releaseRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        holdId: created.hold.holdId,
        releaseReason: "Refund investigation closed",
        now: NOW,
      });
      assert.equal(released.ok, true);
      assert.equal(released.hold.status, HOLD_STATUSES.RELEASED);

      const record = await db.collection("download_access_logs").findOne({ _id: "log-1" });
      assert.equal(record.hold, false);
      assert.equal(record.refundPending, false);
      assert.deepEqual(record.retentionHoldIds, []);
    });

    it("preserves hold markers when overlapping refund and compliance holds exist", async () => {
      const refundHold = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "REF-OVERLAP-1",
          reason: "Refund claim",
        },
      });

      const complianceHold = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.COMPLIANCE,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "COMP-OVERLAP-1",
          reason: "Compliance audit",
        },
      });

      // Release only the refund hold
      await releaseRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        holdId: refundHold.hold.holdId,
        releaseReason: "Refund resolved",
        now: NOW,
      });

      // Record must remain held because compliance hold is still active
      const afterFirstRelease = await db.collection("download_access_logs").findOne({ _id: "log-1" });
      assert.equal(afterFirstRelease.hold, true);
      assert.equal(afterFirstRelease.refundPending, false);
      assert.equal(afterFirstRelease.legalHold, true);
      assert.equal(afterFirstRelease.auditHold, true);
      assert.deepEqual(afterFirstRelease.retentionHoldIds, [complianceHold.hold.holdId]);

      // Release the compliance hold
      await releaseRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        holdId: complianceHold.hold.holdId,
        releaseReason: "Audit closed",
        now: NOW,
      });

      const afterSecondRelease = await db.collection("download_access_logs").findOne({ _id: "log-1" });
      assert.equal(afterSecondRelease.hold, false);
      assert.equal(afterSecondRelease.legalHold, false);
      assert.equal(afterSecondRelease.auditHold, false);
      assert.deepEqual(afterSecondRelease.retentionHoldIds, []);
    });
  });

  describe("Retry and idempotency paths", () => {
    it("returns the existing hold on retry with the same idempotencyKey and payload", async () => {
      const payload = {
        investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
        targetCollection: "download_access_logs",
        targetRecordIds: ["log-1"],
        caseId: "REF-RETRY-1",
        reason: "Network timeout retry test",
        idempotencyKey: "idem-key-001",
      };

      const first = await createRetentionHold({ db, actorContext: ADMIN_ACTOR, now: NOW, input: payload });
      const second = await createRetentionHold({ db, actorContext: ADMIN_ACTOR, now: NOW, input: payload });

      assert.equal(first.ok, true);
      assert.equal(first.status, 201);
      assert.equal(second.ok, true);
      assert.equal(second.status, 200);
      assert.equal(second.idempotent, true);
      assert.equal(second.hold.holdId, first.hold.holdId);

      const holds = await db.collection(RETENTION_HOLDS_COLLECTION).find({}).toArray();
      assert.equal(holds.length, 1);

      const audits = await db.collection(AUDIT_LEDGER_COLLECTION).find({}).toArray();
      assert.equal(audits.length, 1);
    });

    it("rejects idempotencyKey reuse with a different payload (409 IDEMPOTENCY_CONFLICT)", async () => {
      await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "REF-RETRY-2",
          reason: "Initial request",
          idempotencyKey: "idem-key-conflict",
        },
      });

      const conflict = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.COMPLIANCE,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-2"],
          caseId: "COMP-DIFFERENT",
          reason: "Different payload",
          idempotencyKey: "idem-key-conflict",
        },
      });

      assert.equal(conflict.ok, false);
      assert.equal(conflict.status, 409);
      assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
    });

    it("makes releaseRetentionHold idempotent on repeated calls", async () => {
      const created = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "REF-REL-1",
          reason: "Hold to release twice",
        },
      });

      const firstRelease = await releaseRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        holdId: created.hold.holdId,
        releaseReason: "Closed",
        now: NOW,
      });
      const secondRelease = await releaseRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        holdId: created.hold.holdId,
        releaseReason: "Closed",
        now: NOW,
      });

      assert.equal(firstRelease.ok, true);
      assert.equal(firstRelease.idempotent, false);
      assert.equal(secondRelease.ok, true);
      assert.equal(secondRelease.idempotent, true);
    });
  });

  describe("Failure and rollback paths", () => {
    it("rejects invalid investigationType, reserved collection, and past expiresAt", async () => {
      const badType = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: "unknown_type",
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "CASE-1",
          reason: "Test",
        },
      });
      assert.equal(badType.ok, false);
      assert.equal(badType.status, 400);
      assert.equal(badType.code, "INVALID_INVESTIGATION_TYPE");

      const reservedColl = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.COMPLIANCE,
          targetCollection: "audit_ledger",
          targetRecordIds: ["a-1"],
          caseId: "CASE-2",
          reason: "Test",
        },
      });
      assert.equal(reservedColl.ok, false);
      assert.equal(reservedColl.status, 400);
      assert.equal(reservedColl.code, "INVALID_TARGET_COLLECTION");

      const pastExpiry = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "CASE-3",
          reason: "Test",
          expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        },
      });
      assert.equal(pastExpiry.ok, false);
      assert.equal(pastExpiry.status, 400);
      assert.equal(pastExpiry.code, "INVALID_EXPIRES_AT");
    });

    it("rolls back applied markers when requireAllTargetsExist is true and a target is missing", async () => {
      const result = await createRetentionHold({
        db,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1", "nonexistent-log"],
          caseId: "REF-STRICT-1",
          reason: "Strict target validation",
          requireAllTargetsExist: true,
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 404);
      assert.equal(result.code, "TARGET_RECORDS_NOT_FOUND");
      assert.equal(result.rolledBack, true);
      assert.deepEqual(result.missingRecordIds, ["nonexistent-log"]);

      // log-1 must have been rolled back
      const log1 = await db.collection("download_access_logs").findOne({ _id: "log-1" });
      assert.equal(log1.hold, false);
      assert.equal(log1.refundPending, false);
      assert.deepEqual(log1.retentionHoldIds, []);
    });

    it("rolls back partial markers on mid-operation DB failure and records failure audit", async () => {
      const failingDb = createInMemoryDb({ failUpdateOnId: "log-2" });
      await failingDb.collection("download_access_logs").insertOne({ _id: "log-1" });
      await failingDb.collection("download_access_logs").insertOne({ _id: "log-2" });

      const result = await createRetentionHold({
        db: failingDb,
        actorContext: ADMIN_ACTOR,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.COMPLIANCE,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1", "log-2"],
          caseId: "COMP-FAIL-1",
          reason: "Mid-batch failure test",
        },
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, 500);
      assert.equal(result.code, "HOLD_APPLICATION_FAILED");
      assert.equal(result.rolledBack, true);

      // log-1 was updated before log-2 failed, so it must be rolled back
      const log1 = await failingDb.collection("download_access_logs").findOne({ _id: "log-1" });
      assert.equal(log1.hold, false);
      assert.equal(log1.legalHold, false);
      assert.deepEqual(log1.retentionHoldIds, []);

      const holds = await failingDb.collection(RETENTION_HOLDS_COLLECTION).find({}).toArray();
      assert.equal(holds[0].status, HOLD_STATUSES.ROLLED_BACK);

      const audits = await failingDb.collection(AUDIT_LEDGER_COLLECTION).find({}).toArray();
      assert.equal(audits[0].action, "RETENTION_HOLD_FAILED");
    });
  });

  describe("Authorization paths", () => {
    it("rejects unauthenticated callers (401)", async () => {
      const res = await createRetentionHold({
        db,
        actorContext: null,
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "REF-AUTH-1",
          reason: "Unauthenticated attempt",
        },
      });
      assert.equal(res.ok, false);
      assert.equal(res.status, 401);
      assert.equal(res.code, "UNAUTHENTICATED");
    });

    it("rejects non-admin roles (creator, learner, user) with 403", async () => {
      for (const role of ["user", "learner", "creator"]) {
        const res = await createRetentionHold({
          db,
          actorContext: { sub: `${role}-1`, role },
          now: NOW,
          input: {
            investigationType: HOLD_INVESTIGATION_TYPES.REFUND,
            targetCollection: "download_access_logs",
            targetRecordIds: ["log-1"],
            caseId: "REF-AUTH-2",
            reason: "Unauthorized role attempt",
          },
        });
        assert.equal(res.ok, false);
        assert.equal(res.status, 403);
        assert.equal(res.code, "FORBIDDEN");
      }
    });

    it("rejects suspended admin accounts with 403", async () => {
      const res = await createRetentionHold({
        db,
        actorContext: { sub: "admin-suspended", role: "admin", suspended: true },
        now: NOW,
        input: {
          investigationType: HOLD_INVESTIGATION_TYPES.COMPLIANCE,
          targetCollection: "download_access_logs",
          targetRecordIds: ["log-1"],
          caseId: "COMP-AUTH-3",
          reason: "Suspended admin attempt",
        },
      });
      assert.equal(res.ok, false);
      assert.equal(res.status, 403);
      assert.equal(res.code, "ACTOR_SUSPENDED");
    });
  });
});
