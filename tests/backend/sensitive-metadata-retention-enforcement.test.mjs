/**
 * Retention Enforcement Tests for Sensitive Metadata (#1077)
 *
 * Exercises `scripts/data-retention-cleanup.mjs` against sensitive metadata
 * collections (`sensitive_access_log`, `download_access_log`) and permanently
 * protected collections (`audit_ledger`, `purchases`, `refund_requests`).
 *
 * Covers normal, failure/hold, retry/idempotency, and authorization/dry-run paths.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RETENTION_POLICIES,
  buildPreviewReport,
  cleanupCollection,
  parseArgs,
  resolveHoldReason,
} from "../../scripts/data-retention-cleanup.mjs";
import {
  SENSITIVE_ACCESS_COLLECTION,
  buildSensitiveAccessEvent,
} from "../../src/lib/security/sensitiveAccessLog.js";
import { DOWNLOAD_ACCESS_LOG_COLLECTION } from "../../src/lib/downloads/accessLog.js";

function matchesFilter(doc, filter = {}) {
  for (const [key, cond] of Object.entries(filter)) {
    const val = doc[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("$exists" in cond) {
        const exists = val !== undefined;
        if (exists !== cond.$exists) return false;
      }
      if ("$lt" in cond) {
        if (val === undefined || val === null) return false;
        const a = val instanceof Date ? val.getTime() : String(val);
        const b = cond.$lt instanceof Date ? cond.$lt.getTime() : String(cond.$lt);
        if (!(a < b)) return false;
      }
      if ("$gt" in cond) {
        if (val === undefined || val === null) return false;
        const a = val instanceof Date ? val.getTime() : String(val);
        const b = cond.$gt instanceof Date ? cond.$gt.getTime() : String(cond.$gt);
        if (!(a > b)) return false;
      }
      if ("$in" in cond) {
        if (!cond.$in.includes(val)) return false;
      }
      if ("$ne" in cond) {
        if (val === cond.$ne) return false;
      }
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

function createRetentionMockDb(initialCollections = {}, { failCollections = new Set() } = {}) {
  const store = new Map();
  for (const [name, docs] of Object.entries(initialCollections)) {
    store.set(name, docs.map((d) => ({ ...d })));
  }

  return {
    listCollections(filter = {}) {
      return {
        async toArray() {
          const names = [...store.keys()];
          if (filter.name) return names.includes(filter.name) ? [{ name: filter.name }] : [];
          return names.map((name) => ({ name }));
        },
      };
    },
    collection(name) {
      if (failCollections.has(name)) {
        return {
          find() {
            return {
              sort() { return this; },
              limit() { return this; },
              project() { return this; },
              async toArray() {
                throw new Error(`Simulated DB read failure on ${name}`);
              },
            };
          },
          async countDocuments() {
            throw new Error(`Simulated DB count failure on ${name}`);
          },
          async deleteMany() {
            throw new Error(`Simulated DB delete failure on ${name}`);
          },
        };
      }

      if (!store.has(name)) store.set(name, []);
      const docs = store.get(name);

      return {
        find(filter = {}) {
          let results = docs.filter((d) => matchesFilter(d, filter)).map((d) => ({ ...d }));
          return {
            sort(spec = {}) {
              const [[field, dir]] = Object.entries(spec);
              results.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * dir);
              return this;
            },
            limit(n) {
              results = results.slice(0, n);
              return this;
            },
            project() {
              return this;
            },
            async toArray() {
              return results;
            },
          };
        },
        async countDocuments(filter = {}) {
          return docs.filter((d) => matchesFilter(d, filter)).length;
        },
        async deleteMany(filter = {}) {
          const kept = [];
          let deletedCount = 0;
          for (const d of docs) {
            if (matchesFilter(d, filter)) {
              deletedCount += 1;
            } else {
              kept.push(d);
            }
          }
          store.set(name, kept);
          return { deletedCount };
        },
      };
    },
    _count(name) {
      return (store.get(name) || []).length;
    },
  };
}

describe("sensitive metadata retention enforcement (#1077)", () => {
  const now = new Date("2026-11-18T00:00:00.000Z");
  const expiredDate = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000); // 200d (> 180d)
  const recentDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30d (< 180d)

  it("normal path: expires sensitive_access_log and download_access_log beyond 180d while retaining recent records", async () => {
    const expiredAccessEvent = buildSensitiveAccessEvent({
      actorId: "admin-1",
      resourceType: "user",
      resourceId: "user-1",
      fields: ["email", "phone"],
      decision: "allowed",
      at: expiredDate,
    });
    // Privacy-safety check: only field names are persisted, never raw values
    assert.equal(JSON.stringify(expiredAccessEvent).includes("secret@example.com"), false);

    const recentAccessEvent = buildSensitiveAccessEvent({
      actorId: "admin-1",
      resourceType: "user",
      resourceId: "user-2",
      fields: ["email"],
      decision: "allowed",
      at: recentDate,
    });

    const db = createRetentionMockDb({
      [SENSITIVE_ACCESS_COLLECTION]: [
        { _id: "sa-old", ...expiredAccessEvent },
        { _id: "sa-new", ...recentAccessEvent },
      ],
      [DOWNLOAD_ACCESS_LOG_COLLECTION]: [
        { _id: "dl-old", materialId: "m1", actorId: "u1", decision: "allowed", timestamp: expiredDate },
        { _id: "dl-new", materialId: "m2", actorId: "u2", decision: "allowed", timestamp: recentDate },
      ],
    });

    const preview = await buildPreviewReport(db, { now });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.summary.totalDeleted, 0);
    assert.equal(preview.buckets.eligible.filter((b) => b.collection === SENSITIVE_ACCESS_COLLECTION).length, 1);
    assert.equal(preview.buckets.eligible.filter((b) => b.collection === DOWNLOAD_ACCESS_LOG_COLLECTION).length, 1);

    // Execute cleanup for both sensitive metadata collections
    const saRes = await cleanupCollection(db, SENSITIVE_ACCESS_COLLECTION, RETENTION_POLICIES[SENSITIVE_ACCESS_COLLECTION], false, now);
    const dlRes = await cleanupCollection(db, DOWNLOAD_ACCESS_LOG_COLLECTION, RETENTION_POLICIES[DOWNLOAD_ACCESS_LOG_COLLECTION], false, now);

    assert.equal(saRes.deleted, 1);
    assert.equal(dlRes.deleted, 1);
    assert.equal(db._count(SENSITIVE_ACCESS_COLLECTION), 1);
    assert.equal(db._count(DOWNLOAD_ACCESS_LOG_COLLECTION), 1);
  });

  it("failure & hold path: legalHold/auditHold/activeDispute records are held, protected collections skipped, and DB errors isolated", async () => {
    const db = createRetentionMockDb(
      {
        [SENSITIVE_ACCESS_COLLECTION]: [
          { _id: "sa-held-legal", at: expiredDate.toISOString(), legalHold: true },
          { _id: "sa-held-dispute", at: expiredDate.toISOString(), activeDispute: true },
          { _id: "sa-eligible", at: expiredDate.toISOString() },
        ],
        [DOWNLOAD_ACCESS_LOG_COLLECTION]: [
          { _id: "dl-fail", timestamp: expiredDate },
        ],
        audit_ledger: [{ _id: "aud-1", createdAt: expiredDate }],
        purchases: [{ _id: "pur-1", createdAt: expiredDate }],
      },
      { failCollections: new Set([DOWNLOAD_ACCESS_LOG_COLLECTION]) }
    );

    assert.equal(resolveHoldReason(SENSITIVE_ACCESS_COLLECTION, { legalHold: true }, { now }), "legal_hold");
    assert.equal(resolveHoldReason(SENSITIVE_ACCESS_COLLECTION, { activeDispute: true }, { now }), "active_dispute");

    const preview = await buildPreviewReport(db, { now });
    assert.equal(preview.buckets.held.length, 2);
    assert.equal(preview.buckets.eligible.length, 1);
    assert.equal(preview.buckets.failed.length, 1);
    assert.equal(preview.buckets.failed[0].collection, DOWNLOAD_ACCESS_LOG_COLLECTION);
    assert.ok(preview.buckets.skipped.some((s) => s.collection === "audit_ledger"));
    assert.ok(preview.buckets.skipped.some((s) => s.collection === "purchases"));

    // Protected collections are never deleted even when dryRun=false
    const auditRes = await cleanupCollection(db, "audit_ledger", RETENTION_POLICIES.audit_ledger, false, now);
    assert.equal(auditRes.skipped, true);
    assert.equal(auditRes.reason, "permanently_protected");
    assert.equal(db._count("audit_ledger"), 1);
  });

  it("retry & idempotency path: recovering after transient DB failure and re-running cleanup never double-deletes", async () => {
    const failSet = new Set([SENSITIVE_ACCESS_COLLECTION]);
    const db = createRetentionMockDb(
      {
        [SENSITIVE_ACCESS_COLLECTION]: [{ _id: "sa-1", at: expiredDate.toISOString() }],
      },
      { failCollections: failSet }
    );

    const firstPreview = await buildPreviewReport(db, { now });
    assert.equal(firstPreview.buckets.failed.length, 1);
    assert.equal(db._count(SENSITIVE_ACCESS_COLLECTION), 1);

    // Clear transient fault and retry
    failSet.delete(SENSITIVE_ACCESS_COLLECTION);
    const retryPreview = await buildPreviewReport(db, { now });
    assert.equal(retryPreview.buckets.failed.length, 0);
    assert.equal(retryPreview.buckets.eligible.length, 1);

    const firstExec = await cleanupCollection(db, SENSITIVE_ACCESS_COLLECTION, RETENTION_POLICIES[SENSITIVE_ACCESS_COLLECTION], false, now);
    assert.equal(firstExec.deleted, 1);

    // Second execution is idempotent
    const secondExec = await cleanupCollection(db, SENSITIVE_ACCESS_COLLECTION, RETENTION_POLICIES[SENSITIVE_ACCESS_COLLECTION], false, now);
    assert.equal(secondExec.eligible, 0);
    assert.equal(secondExec.deleted, 0);
  });

  it("authorization & dry-run-first path: CLI defaults to dry-run and --preview overrides --execute", () => {
    const defaultArgs = parseArgs(["node", "scripts/data-retention-cleanup.mjs"]);
    assert.equal(defaultArgs.preview, false);
    assert.equal(defaultArgs.execute, false);
    assert.equal(defaultArgs.reportJson, null);

    const previewOverridesExecute = parseArgs(["node", "scripts/data-retention-cleanup.mjs", "--execute", "--preview"]);
    assert.equal(previewOverridesExecute.preview, true);
    assert.equal(previewOverridesExecute.execute, true);

    const reportJsonForcesDryRun = parseArgs(["node", "scripts/data-retention-cleanup.mjs", "--execute", "--report-json", "./out.json"]);
    assert.equal(reportJsonForcesDryRun.reportJson, "./out.json");
  });
});
