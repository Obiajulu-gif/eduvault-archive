/**
 * Dry-run repair tooling with checkpoints — Issue #1084
 *
 * Covers the normal path (plan → apply → report), failure paths (stale
 * records, write failures, audit outage, invalid proposals), retry/resume
 * paths (interrupted dry-run, interrupted apply, crash after write), rollback
 * (clean and conflicting), and authorization.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  REPAIR_ITEM_STATUS,
  REPAIR_PLAN_ITEMS_COLLECTION,
  REPAIR_PLAN_STATUS,
  REPAIR_PLANS_COLLECTION,
  RepairPlanError,
  applyRepairPlan,
  planRepair,
  rollbackRepairPlan,
  summarizePlan,
} from "../../src/lib/maintenance/repairPlan.js";
import { detectMaterialRepair } from "../../src/lib/maintenance/materialRepairRules.js";
import { createMemoryMongo } from "./helpers/memoryMongo.mjs";

const admin = { id: "op-admin", role: "admin" };
const secondAdmin = { id: "op-second", role: "admin" };
const creator = { id: "creator-1", role: "creator" };
const fixedNow = () => new Date("2026-11-19T00:00:00.000Z");

function seedMaterials() {
  return createMemoryMongo({
    materials: [
      { _id: "m1", title: "Algebra", fileUrl: "ipfs://a", visibility: "public", price: 5 },
      { _id: "m2", title: "Biology", storageKey: "k2", visibility: "private", price: 0 },
      { _id: "m3", title: "Chemistry", storageKey: "k3", visibility: "public", price: 3 },
      { _id: "m4", title: "Deleted", storageKey: "k4", isDeleted: true, searchVersion: 4, visibility: "public", price: 2 },
      { _id: "m5", title: "Economics", fileUrl: "ipfs://e", visibility: "private", price: 0 },
    ],
  });
}

const base = { collectionName: "materials", detect: detectMaterialRepair, ruleVersion: "materials-v1", audit: false, now: fixedNow };

describe("planRepair (dry-run)", () => {
  test("records exact before/after values without writing to the target collection", async () => {
    const db = seedMaterials();
    const before = db.all("materials");

    const report = await planRepair({ db, planId: "plan-1", actor: admin, ...base });

    assert.equal(report.status, REPAIR_PLAN_STATUS.PLANNED);
    assert.equal(report.scanned, 5);
    assert.equal(report.proposed, 4);
    assert.match(report.planHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(db.all("materials"), before, "dry-run must not touch materials");

    const item = db.get(REPAIR_PLAN_ITEMS_COLLECTION, 'plan-1:"m5"');
    assert.deepEqual(
      item.changes.map((c) => [c.field, c.beforeExists, c.before, c.after]),
      [
        ["storageKey", false, null, "ipfs://e"],
        ["visibility", true, "private", "public"],
      ]
    );
    assert.equal(item.status, REPAIR_ITEM_STATUS.PENDING);
  });

  test("the plan hash is deterministic for the same data", async () => {
    const a = await planRepair({ db: seedMaterials(), planId: "plan-a", actor: admin, ...base });
    const b = await planRepair({ db: seedMaterials(), planId: "plan-a", actor: admin, ...base });
    assert.equal(a.planHash, b.planHash);
  });

  test("an interrupted dry-run resumes from its checkpoint and yields the same plan", async () => {
    const reference = await planRepair({ db: seedMaterials(), planId: "plan-r", actor: admin, ...base });

    const db = seedMaterials();
    const partial = await planRepair({ db, planId: "plan-r", actor: admin, ...base, batchSize: 2, maxBatches: 1 });
    assert.equal(partial.status, REPAIR_PLAN_STATUS.PLANNING);
    assert.deepEqual(partial.checkpoint, { lastScannedId: "m2" });
    assert.equal(partial.scanned, 2);

    const resumed = await planRepair({ db, planId: "plan-r", actor: admin, ...base, batchSize: 2 });
    assert.equal(resumed.status, REPAIR_PLAN_STATUS.PLANNED);
    assert.equal(resumed.scanned, 5);
    assert.equal(resumed.planHash, reference.planHash);
  });

  test("a crash mid-batch is retried without duplicate items", async () => {
    const db = seedMaterials();
    db.failNext(REPAIR_PLANS_COLLECTION, "updateOne", 1); // checkpoint write fails after items were written
    await assert.rejects(() => planRepair({ db, planId: "plan-c", actor: admin, ...base, batchSize: 10 }), /simulated outage/);

    const report = await planRepair({ db, planId: "plan-c", actor: admin, ...base, batchSize: 10 });
    assert.equal(report.status, REPAIR_PLAN_STATUS.PLANNED);
    assert.equal(db.all(REPAIR_PLAN_ITEMS_COLLECTION).length, 4);
  });

  test("re-running a finished plan returns the stored report without rescanning", async () => {
    const db = seedMaterials();
    const first = await planRepair({ db, planId: "plan-i", actor: admin, ...base });
    db.put("materials", { _id: "m6", title: "New", fileUrl: "ipfs://n", visibility: "public", price: 1 });
    const again = await planRepair({ db, planId: "plan-i", actor: admin, ...base });
    assert.equal(again.planHash, first.planHash);
    assert.equal(again.proposed, 4);
  });

  test("reusing a planId for a different collection or query is rejected", async () => {
    const db = seedMaterials();
    await planRepair({ db, planId: "plan-x", actor: admin, ...base });
    await assert.rejects(
      () => planRepair({ db, planId: "plan-x", actor: admin, ...base, query: { visibility: "private" } }),
      (error) => error instanceof RepairPlanError && error.code === "REPAIR_PLAN_CONFLICT" && error.status === 409
    );
  });

  test("invalid proposals are rejected before anything is planned for that record", async () => {
    for (const detect of [
      () => ({ set: { _id: "evil" } }),
      () => ({ set: { "profile.name": "x" } }),
      () => ({ set: { $where: "1" } }),
      () => ({ set: { a: 1 }, unset: ["a"] }),
      () => ({ set: { a: undefined } }),
      () => ({ set: "nope" }),
    ]) {
      const db = seedMaterials();
      await assert.rejects(
        () => planRepair({ db, planId: "plan-bad", actor: admin, ...base, detect }),
        (error) => error instanceof RepairPlanError && error.status === 400
      );
    }
  });

  test("a query that constrains _id and a malformed planId are rejected", async () => {
    const db = seedMaterials();
    await assert.rejects(() => planRepair({ db, planId: "p", actor: admin, ...base, query: { _id: "m1" } }), /REPAIR_INVALID_QUERY|_id cursor/);
    await assert.rejects(() => planRepair({ db, planId: "../etc", actor: admin, ...base }), /planId/);
  });
});

describe("applyRepairPlan", () => {
  async function planned(db = seedMaterials(), planId = "plan-apply") {
    const report = await planRepair({ db, planId, actor: admin, ...base });
    return { db, report };
  }

  test("applies the reviewed plan with compare-and-set writes", async () => {
    const { db, report } = await planned();
    const result = await applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: report.planHash, actor: admin, audit: false, now: fixedNow });

    assert.equal(result.status, REPAIR_PLAN_STATUS.APPLIED);
    assert.equal(result.run.applied, 4);
    assert.equal(db.get("materials", "m1").storageKey, "ipfs://a");
    assert.equal(db.get("materials", "m2").visibility, "public");
    assert.equal(db.get("materials", "m4").searchVersion, 0);
    assert.deepEqual(db.get("materials", "m3"), { _id: "m3", title: "Chemistry", storageKey: "k3", visibility: "public", price: 3 });
  });

  test("refuses to apply when the plan hash does not match what was reviewed", async () => {
    const { db } = await planned();
    await assert.rejects(
      () => applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: "0".repeat(64), actor: admin, audit: false }),
      (error) => error.code === "REPAIR_PLAN_HASH_MISMATCH" && error.status === 409
    );
    assert.equal(db.get("materials", "m1").storageKey, undefined);
  });

  test("refuses to apply an unfinished dry-run or an unknown plan", async () => {
    const db = seedMaterials();
    await planRepair({ db, planId: "plan-half", actor: admin, ...base, batchSize: 1, maxBatches: 1 });
    await assert.rejects(() => applyRepairPlan({ db, planId: "plan-half", expectedPlanHash: "x", actor: admin, audit: false }), /REPAIR_PLAN_INCOMPLETE|not finished/);
    await assert.rejects(() => applyRepairPlan({ db, planId: "nope", expectedPlanHash: "x", actor: admin, audit: false }), (e) => e.status === 404);
  });

  test("a record changed after the dry-run is skipped as stale, never overwritten", async () => {
    const { db, report } = await planned();
    db.put("materials", { _id: "m2", title: "Biology", storageKey: "k2", visibility: "private", price: 9 }); // now priced
    db.put("materials", { _id: "m1", title: "Algebra", fileUrl: "ipfs://a", storageKey: "manual-fix", visibility: "public", price: 5 });

    const result = await applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: report.planHash, actor: admin, audit: false });

    assert.equal(result.status, REPAIR_PLAN_STATUS.PARTIALLY_APPLIED);
    assert.equal(result.counts[REPAIR_ITEM_STATUS.SKIPPED_STALE], 2);
    assert.equal(result.counts[REPAIR_ITEM_STATUS.APPLIED], 2);
    // m1: the repaired field itself changed.
    assert.equal(db.get("materials", "m1").storageKey, "manual-fix");
    // m2: only a guard field (price) changed — the rule no longer applies, so it is not forced.
    assert.equal(db.get("materials", "m2").visibility, "private");
  });

  test("an interrupted apply resumes from item checkpoints", async () => {
    const { db, report } = await planned();
    const first = await applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: report.planHash, actor: admin, maxItems: 2, audit: false });
    assert.equal(first.status, REPAIR_PLAN_STATUS.APPLYING);
    assert.equal(first.run.applied, 2);
    assert.equal(first.retryable, 2);

    const second = await applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: report.planHash, actor: admin, audit: false });
    assert.equal(second.status, REPAIR_PLAN_STATUS.APPLIED);
    assert.equal(second.run.applied, 2);
    assert.equal(second.counts[REPAIR_ITEM_STATUS.APPLIED], 4);
  });

  test("a crash after the record write but before the item checkpoint is recognised on retry", async () => {
    const { db, report } = await planned();
    db.failNext(REPAIR_PLAN_ITEMS_COLLECTION, "updateOne", 2); // item status write fails, then its failure write fails
    await assert.rejects(() => applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: report.planHash, actor: admin, audit: false }));
    assert.equal(db.get("materials", "m1").storageKey, "ipfs://a", "the record write landed");

    const retry = await applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: report.planHash, actor: admin, audit: false });
    assert.equal(retry.status, REPAIR_PLAN_STATUS.APPLIED);
    assert.equal(retry.run.alreadyApplied, 1);
    assert.equal(retry.counts[REPAIR_ITEM_STATUS.SKIPPED_STALE], 0);
  });

  test("failed writes are retried up to maxAttempts, then reported", async () => {
    const { db, report } = await planned();
    db.failNext("materials", "updateOne", 1);
    const first = await applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: report.planHash, actor: admin, maxAttempts: 2, audit: false });
    assert.equal(first.run.failed, 1);
    assert.equal(first.status, REPAIR_PLAN_STATUS.APPLYING, "a retryable failure keeps the plan resumable");

    const second = await applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: report.planHash, actor: admin, maxAttempts: 2, audit: false });
    assert.equal(second.status, REPAIR_PLAN_STATUS.APPLIED);

    // Exhausting attempts ends in partially_applied with the error kept on the item.
    const other = await planned(seedMaterials(), "plan-exhaust");
    other.db.failNext("materials", "updateOne", 2);
    await applyRepairPlan({ db: other.db, planId: "plan-exhaust", expectedPlanHash: other.report.planHash, actor: admin, maxAttempts: 2, maxItems: 1, audit: false });
    const exhausted = await applyRepairPlan({ db: other.db, planId: "plan-exhaust", expectedPlanHash: other.report.planHash, actor: admin, maxAttempts: 2, audit: false });
    assert.equal(exhausted.status, REPAIR_PLAN_STATUS.PARTIALLY_APPLIED);
    const failed = other.db.all(REPAIR_PLAN_ITEMS_COLLECTION).find((i) => i.status === REPAIR_ITEM_STATUS.FAILED);
    assert.equal(failed.attempts, 2);
    assert.equal(failed.lastError.message, "simulated outage");
  });

  test("an unavailable audit trail blocks the apply before any write", async () => {
    const { db, report } = await planned();
    const audit = async () => {
      throw new Error("audit ledger down");
    };
    await assert.rejects(() => applyRepairPlan({ db, planId: "plan-apply", expectedPlanHash: report.planHash, actor: admin, audit }), /audit ledger down/);
    assert.equal(db.get("materials", "m1").storageKey, undefined);
  });

  test("writes hash-chained audit records through the audit ledger by default", async () => {
    const db = seedMaterials();
    const report = await planRepair({ db, planId: "plan-audit", actor: admin, ...base, audit: undefined });
    await applyRepairPlan({ db, planId: "plan-audit", expectedPlanHash: report.planHash, actor: admin });
    const actions = db.all("audit_ledger").map((r) => r.action);
    assert.deepEqual(actions, ["repair.planned", "repair.apply_started", "repair.applied"]);
  });
});

describe("rollbackRepairPlan", () => {
  async function applied() {
    const db = seedMaterials();
    const report = await planRepair({ db, planId: "plan-rb", actor: admin, ...base });
    await applyRepairPlan({ db, planId: "plan-rb", expectedPlanHash: report.planHash, actor: admin, audit: false });
    return db;
  }

  test("restores before-values, including removing fields the repair added", async () => {
    const original = seedMaterials().all("materials");
    const db = await applied();
    const result = await rollbackRepairPlan({ db, planId: "plan-rb", actor: admin, reason: "bad rule", audit: false });
    assert.equal(result.status, REPAIR_PLAN_STATUS.ROLLED_BACK);
    assert.equal(result.run.restored, 4);
    assert.deepEqual(db.all("materials"), original);
  });

  test("never overwrites a record edited after the repair", async () => {
    const db = await applied();
    db.put("materials", { ...db.get("materials", "m2"), visibility: "unlisted" });
    const result = await rollbackRepairPlan({ db, planId: "plan-rb", actor: admin, reason: "bad rule", audit: false });
    assert.equal(result.status, REPAIR_PLAN_STATUS.ROLLED_BACK_WITH_CONFLICTS);
    assert.equal(result.counts[REPAIR_ITEM_STATUS.ROLLBACK_CONFLICT], 1);
    assert.equal(db.get("materials", "m2").visibility, "unlisted");
  });

  test("is idempotent and requires a reason and an applied plan", async () => {
    const db = await applied();
    await assert.rejects(() => rollbackRepairPlan({ db, planId: "plan-rb", actor: admin, reason: " ", audit: false }), /reason/);
    await rollbackRepairPlan({ db, planId: "plan-rb", actor: admin, reason: "bad rule", audit: false });
    const again = await rollbackRepairPlan({ db, planId: "plan-rb", actor: admin, reason: "bad rule", audit: false });
    assert.equal(again.run.restored, 0);

    const fresh = seedMaterials();
    await planRepair({ db: fresh, planId: "plan-none", actor: admin, ...base });
    await assert.rejects(
      () => rollbackRepairPlan({ db: fresh, planId: "plan-none", actor: admin, reason: "x", audit: false }),
      (e) => e.code === "REPAIR_PLAN_NOT_ROLLBACKABLE"
    );
  });
});

describe("authorization", () => {
  test("non-operators cannot plan, apply, or roll back", async () => {
    const db = seedMaterials();
    for (const actor of [null, creator, { role: "admin" }, "someone"]) {
      await assert.rejects(
        () => planRepair({ db, planId: "plan-auth", actor, ...base }),
        (e) => e instanceof RepairPlanError && e.status === 403
      );
    }
    const report = await planRepair({ db, planId: "plan-auth", actor: admin, ...base });
    await assert.rejects(() => applyRepairPlan({ db, planId: "plan-auth", expectedPlanHash: report.planHash, actor: creator, audit: false }), (e) => e.status === 403);
    await assert.rejects(() => rollbackRepairPlan({ db, planId: "plan-auth", actor: creator, reason: "x", audit: false }), (e) => e.status === 403);
    assert.equal(db.get("materials", "m1").storageKey, undefined);
  });

  test("an explicit authorize callback is honoured (runResumableRepair contract)", async () => {
    const db = seedMaterials();
    const report = await planRepair({ db, planId: "plan-cb", actor: "cron-repair", authorize: (a) => a === "cron-repair", ...base });
    assert.equal(report.status, REPAIR_PLAN_STATUS.PLANNED);
    await assert.rejects(() => planRepair({ db, planId: "plan-cb2", actor: admin, authorize: () => false, ...base }), (e) => e.status === 403);
  });

  test("requireSeparateApprover enforces four-eyes on apply", async () => {
    const db = seedMaterials();
    const report = await planRepair({ db, planId: "plan-4e", actor: admin, ...base });
    await assert.rejects(
      () => applyRepairPlan({ db, planId: "plan-4e", expectedPlanHash: report.planHash, actor: admin, requireSeparateApprover: true, audit: false }),
      (e) => e.code === "REPAIR_SEPARATE_APPROVER_REQUIRED"
    );
    const result = await applyRepairPlan({ db, planId: "plan-4e", expectedPlanHash: report.planHash, actor: secondAdmin, requireSeparateApprover: true, audit: false });
    assert.equal(result.status, REPAIR_PLAN_STATUS.APPLIED);
  });
});

test("summarizePlan reports counts and samples for review", async () => {
  const db = seedMaterials();
  await planRepair({ db, planId: "plan-s", actor: admin, ...base });
  const summary = await summarizePlan(db, "plan-s");
  assert.equal(summary.counts[REPAIR_ITEM_STATUS.PENDING], 4);
  assert.deepEqual(summary.samples[0], { targetId: "m1", reason: "missing-storage-key", status: "pending", fields: ["storageKey"] });
});

describe("repair-materials CLI plan commands", () => {
  test("plan → status → apply → rollback through runPlanCommand", async () => {
    const { runPlanCommand } = await import("../../scripts/repair-materials.mjs");
    const db = seedMaterials();
    const argv = (...args) => ["node", "scripts/repair-materials.mjs", ...args];

    assert.equal(await runPlanCommand({ db, argv: argv("--apply"), operator: "ops" }), null, "legacy mode is untouched");
    await assert.rejects(() => runPlanCommand({ db, argv: argv("--plan", "cli-1"), operator: null }), /--operator/);

    const planned = await runPlanCommand({ db, argv: argv("--plan", "cli-1"), operator: "ops" });
    assert.equal(planned.status, REPAIR_PLAN_STATUS.PLANNED);
    assert.equal(db.get("materials", "m1").storageKey, undefined);

    const status = await runPlanCommand({ db, argv: argv("--plan-status", "cli-1"), operator: "ops" });
    assert.equal(status.planHash, planned.planHash);

    await assert.rejects(() => runPlanCommand({ db, argv: argv("--apply-plan", "cli-1"), operator: "ops" }), (e) => e.code === "REPAIR_PLAN_HASH_MISMATCH");
    const applied = await runPlanCommand({ db, argv: argv("--apply-plan", "cli-1", "--plan-hash", planned.planHash), operator: "ops" });
    assert.equal(applied.status, REPAIR_PLAN_STATUS.APPLIED);

    const rolled = await runPlanCommand({ db, argv: argv("--rollback-plan", "cli-1", "--reason", "verification"), operator: "ops" });
    assert.equal(rolled.status, REPAIR_PLAN_STATUS.ROLLED_BACK);
    assert.equal(db.get(REPAIR_PLANS_COLLECTION, "cli-1").createdBy, "ops");
  });
});
