import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunState,
  VerificationStatus,
  captureFingerprint,
  compareFingerprints,
  retryRollbackVerification,
  runWithRollbackVerification,
  verifyRollback,
} from "../rollbackVerification.js";
import { createFakeMongo } from "./fakeMongo.js";

const ACTOR = { id: "ops-1", role: "deployer" };
const NOBODY = { id: "intern", role: "viewer" };
const sleep = async () => {};

let db;

beforeEach(() => {
  db = createFakeMongo();
  db.seed("materials", { _id: "m1", title: "A", tier: "free" }, { _id: "m2", title: "B", tier: "free" });
  db.seed("users", { _id: "u1", email: "a@example.com" });
});

const base = () => ({ db, name: "add-tier", actor: ACTOR, targets: ["materials"], sleep, retryDelayMs: 0 });

// A forward step that adds a field to every material.
const migrate = async () => {
  for (const doc of db.all("materials")) db.put("materials", { ...doc, tier: "paid", migrated: true });
};
// The matching rollback.
const undo = async () => {
  for (const doc of db.all("materials")) {
    const { migrated, ...rest } = doc;
    db.put("materials", { ...rest, tier: "free" });
  }
};

async function expectCode(promise, code, reason) {
  const error = await promise.then(() => null, (e) => e);
  expect(error, "expected a rejection").not.toBeNull();
  expect(error.code).toBe(code);
  if (reason) expect(error.details.reason).toBe(reason);
}

describe("fingerprints", () => {
  it("is stable for identical data regardless of field order", async () => {
    const a = await captureFingerprint(db, { targets: ["materials"] });
    db.put("materials", { tier: "free", title: "A", _id: "m1" });
    const b = await captureFingerprint(db, { targets: ["materials"] });
    expect(b.collections.materials.digest).toBe(a.collections.materials.digest);
    expect(compareFingerprints(a, b).matches).toBe(true);
  });

  it("detects changed, added and removed documents", async () => {
    const before = await captureFingerprint(db, { targets: ["materials"] });
    db.put("materials", { _id: "m1", title: "A", tier: "paid" });
    let diff = compareFingerprints(before, await captureFingerprint(db, { targets: ["materials"] }));
    expect(diff.differences.map((d) => d.type)).toEqual(["content_changed"]);

    db.put("materials", { _id: "m3" });
    diff = compareFingerprints(before, await captureFingerprint(db, { targets: ["materials"] }));
    expect(diff.differences.map((d) => d.type)).toEqual(["count_changed", "content_changed"]);
  });

  it("scopes to a query and ignores listed fields", async () => {
    const targets = [{ collection: "materials", query: { tier: "free" }, ignoreFields: ["touchedAt"] }];
    const before = await captureFingerprint(db, { targets });
    db.put("materials", { _id: "m1", title: "A", tier: "free", touchedAt: "now" });
    expect(compareFingerprints(before, await captureFingerprint(db, { targets })).matches).toBe(true);
    db.put("users", { _id: "u2" });
    expect(compareFingerprints(before, await captureFingerprint(db, { targets })).matches).toBe(true);
  });

  it("flags truncated scans as partial coverage", async () => {
    const before = await captureFingerprint(db, { targets: ["materials"], maxScan: 1 });
    expect(before.collections.materials).toMatchObject({ count: 2, scanned: 1, truncated: true });
    expect(compareFingerprints(before, before).partialCoverage).toEqual(["materials"]);
  });

  it("treats a lost index as an error and a leftover index as a warning", async () => {
    db.setIndexes("materials", ["_id_", "tier_idx"]);
    const before = await captureFingerprint(db, { targets: ["materials"] });
    db.setIndexes("materials", ["_id_", "extra_idx"]);
    const diff = compareFingerprints(before, await captureFingerprint(db, { targets: ["materials"] }));
    expect(diff.differences).toEqual([
      expect.objectContaining({ type: "index_missing", index: "tier_idx", severity: "error" }),
      expect.objectContaining({ type: "index_added", index: "extra_idx", severity: "warning" }),
    ]);
    expect(diff.matches).toBe(false);
  });

  it("rejects missing targets", async () => {
    await expectCode(captureFingerprint(db, { targets: [] }), "VALIDATION_FIELD");
    await expectCode(captureFingerprint(db, { targets: [{}] }), "VALIDATION_FIELD");
  });
});

describe("verifyRollback", () => {
  it("verifies unchanged data and runs invariants", async () => {
    const before = await captureFingerprint(db, { targets: ["materials"] });
    const run = vi.fn(async () => ({ ok: true }));
    const result = await verifyRollback({ db, before, invariants: [{ name: "inv", run }] });
    expect(result.status).toBe(VerificationStatus.VERIFIED);
    expect(run).toHaveBeenCalledWith(db);
  });

  it("reports drift with the differences", async () => {
    const before = await captureFingerprint(db, { targets: ["materials"] });
    db.remove("materials", "m2");
    const result = await verifyRollback({ db, before });
    expect(result.status).toBe(VerificationStatus.DRIFT);
    expect(result.differences.map((d) => d.type)).toContain("count_changed");
    expect(result.recommendation).toMatch(/retryRollbackVerification/);
  });

  it("fails when an invariant fails or throws", async () => {
    const before = await captureFingerprint(db, { targets: ["materials"] });
    const result = await verifyRollback({
      db,
      before,
      invariants: [
        { name: "bad", run: async () => ({ ok: false, message: "orphans" }) },
        { name: "boom", run: async () => { throw new Error("db gone"); } },
      ],
    });
    expect(result.status).toBe(VerificationStatus.DRIFT);
    expect(result.invariants).toEqual([
      { name: "bad", ok: false, message: "orphans" },
      { name: "boom", ok: false, message: "check threw: db gone" },
    ]);
  });

  it("retries transient read failures", async () => {
    const before = await captureFingerprint(db, { targets: ["materials"] });
    db.failNext("materials", "countDocuments", 2);
    const result = await verifyRollback({ db, before, retries: 2, retryDelayMs: 0, sleep });
    expect(result.status).toBe(VerificationStatus.VERIFIED);
  });

  it("is unverifiable, not verified, when the database cannot be read", async () => {
    const before = await captureFingerprint(db, { targets: ["materials"] });
    db.failNext("materials", "countDocuments", 10);
    const result = await verifyRollback({ db, before, retries: 1, retryDelayMs: 0, sleep });
    expect(result.status).toBe(VerificationStatus.UNVERIFIABLE);
    expect(result.error).toBe("simulated outage");
  });

  it("warns about checkpoints the migration left open", async () => {
    const before = await captureFingerprint(db, { targets: ["materials"] });
    db.seed("migration_checkpoints", { _id: "c1", migrationId: "add-tier", completed: false });
    const result = await verifyRollback({ db, before, migrationId: "add-tier" });
    expect(result.status).toBe(VerificationStatus.VERIFIED);
    expect(result.warnings.join(" ")).toMatch(/checkpoint/);
  });
});

describe("runWithRollbackVerification", () => {
  it("keeps the change when apply and post-checks succeed", async () => {
    const rollback = vi.fn(undo);
    const result = await runWithRollbackVerification({ ...base(), apply: migrate, rollback, postChecks: [{ name: "all-paid", run: async () => ({ ok: true }) }] });
    expect(result.outcome).toBe(RunState.SUCCEEDED);
    expect(rollback).not.toHaveBeenCalled();
    expect(db.get("materials", "m1").tier).toBe("paid");
    expect(db.get("rollback_verifications", result.runId).state).toBe(RunState.SUCCEEDED);
  });

  it("rolls back a failed migration and proves the data is back", async () => {
    const apply = async () => {
      db.put("materials", { _id: "m1", title: "A", tier: "paid", migrated: true });
      throw new Error("crashed halfway");
    };
    const result = await runWithRollbackVerification({
      ...base(),
      apply,
      rollback: async () => db.put("materials", { _id: "m1", title: "A", tier: "free" }),
    });
    expect(result.outcome).toBe(RunState.ROLLED_BACK_VERIFIED);
    expect(result.error).toBe("crashed halfway");
    expect(result.verification.status).toBe(VerificationStatus.VERIFIED);
    expect(db.get("materials", "m1")).toEqual({ _id: "m1", title: "A", tier: "free" });
    expect(db.get("rollback_verifications", result.runId).history.map((h) => h.action)).toEqual(["started", "failed", "rolled_back_verified"]);
  });

  it("rolls back when post-checks fail even though apply returned normally", async () => {
    const result = await runWithRollbackVerification({
      ...base(),
      apply: migrate,
      rollback: undo,
      postChecks: [{ name: "smoke", run: async () => ({ ok: false, message: "5xx" }) }],
    });
    expect(result.outcome).toBe(RunState.ROLLED_BACK_VERIFIED);
    expect(result.error).toBe("post-checks failed: smoke");
    expect(db.get("materials", "m2").tier).toBe("free");
  });

  it("catches a rollback that did not fully restore the data, and blocks the next run", async () => {
    const half = async () => db.put("materials", { ...db.get("materials", "m1"), tier: "free", migrated: undefined });
    const result = await runWithRollbackVerification({
      ...base(),
      apply: async () => { await migrate(); throw new Error("boom"); },
      rollback: half, // m2 is still migrated
    });
    expect(result.outcome).toBe(RunState.ROLLBACK_DRIFT);
    expect(result.verification.differences.some((d) => d.type === "content_changed")).toBe(true);

    const apply = vi.fn();
    await expectCode(runWithRollbackVerification({ ...base(), apply, rollback: undo }), "CONFLICT_STATE", "unresolved_run");
    expect(apply).not.toHaveBeenCalled();
  });

  it("retries a flaky rollback with backoff", async () => {
    const rollback = vi.fn().mockRejectedValueOnce(new Error("lock")).mockImplementationOnce(undo);
    const delays = [];
    const result = await runWithRollbackVerification({
      ...base(),
      apply: async () => { await migrate(); throw new Error("boom"); },
      rollback,
      retryDelayMs: 10,
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(result.outcome).toBe(RunState.ROLLED_BACK_VERIFIED);
    expect(rollback).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([10]);
  });

  it("reports rollback_failed when the rollback keeps failing", async () => {
    const rollback = vi.fn().mockRejectedValue(new Error("cannot connect"));
    const result = await runWithRollbackVerification({
      ...base(),
      apply: async () => { await migrate(); throw new Error("boom"); },
      rollback,
      rollbackRetries: 2,
    });
    expect(result).toMatchObject({ outcome: RunState.ROLLBACK_FAILED, error: "boom", rollbackError: "cannot connect" });
    expect(rollback).toHaveBeenCalledTimes(3);
    expect(db.get("rollback_verifications", result.runId).state).toBe(RunState.ROLLBACK_FAILED);
  });

  it("reports unverifiable when the rollback ran but the data cannot be read back", async () => {
    const result = await runWithRollbackVerification({
      ...base(),
      apply: async () => { await migrate(); throw new Error("boom"); },
      rollback: async () => {
        await undo();
        db.failNext("materials", "countDocuments", 100);
      },
      rollbackRetries: 1,
    });
    expect(result.outcome).toBe(RunState.UNVERIFIABLE);
  });

  it("refuses an unauthorized actor before touching anything", async () => {
    const apply = vi.fn();
    await expectCode(runWithRollbackVerification({ ...base(), actor: NOBODY, apply, rollback: undo }), "AUTH_FORBIDDEN", "not_authorized_for_release");
    await expectCode(runWithRollbackVerification({ ...base(), actor: undefined, apply, rollback: undo }), "AUTH_FORBIDDEN");
    expect(apply).not.toHaveBeenCalled();
    expect(db.all("rollback_verifications")).toHaveLength(0);
  });

  it("refuses to start a change that has no rollback", async () => {
    const apply = vi.fn();
    await expectCode(runWithRollbackVerification({ ...base(), apply, rollback: undefined }), "VALIDATION_FAILED", "missing_rollback");
    await expectCode(runWithRollbackVerification({ ...base(), apply, rollback: undo, name: "" }), "VALIDATION_FIELD");
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not apply anything if the run cannot be recorded", async () => {
    const apply = vi.fn();
    db.failNext("rollback_verifications", "insertOne");
    await expect(runWithRollbackVerification({ ...base(), apply, rollback: undo })).rejects.toThrow("simulated outage");
    expect(apply).not.toHaveBeenCalled();
  });

  it("maps a lost start race on the unique index to a conflict", async () => {
    const apply = vi.fn();
    db.failNext("rollback_verifications", "insertOne", 1, Object.assign(new Error("dup"), { code: 11000 }));
    await expectCode(runWithRollbackVerification({ ...base(), apply, rollback: undo }), "CONFLICT_IN_PROGRESS", "run_in_progress");
    expect(apply).not.toHaveBeenCalled();
  });

  it("lets a different name run while another is unresolved", async () => {
    await runWithRollbackVerification({ ...base(), apply: async () => { throw new Error("x"); }, rollback: async () => { await migrate(); } });
    const other = await runWithRollbackVerification({ ...base(), name: "other", apply: async () => {}, rollback: undo });
    expect(other.outcome).toBe(RunState.SUCCEEDED);
  });
});

describe("retryRollbackVerification", () => {
  async function drifted() {
    return runWithRollbackVerification({
      ...base(),
      apply: async () => { await migrate(); throw new Error("boom"); },
      rollback: async () => {}, // does nothing
    });
  }

  it("re-verifies after an operator repairs the data, then unblocks the name", async () => {
    const run = await drifted();
    expect(run.outcome).toBe(RunState.ROLLBACK_DRIFT);

    const stillBroken = await retryRollbackVerification(db, { runId: run.runId, actor: ACTOR, sleep, retryDelayMs: 0 });
    expect(stillBroken.outcome).toBe(RunState.ROLLBACK_DRIFT);

    await undo(); // manual repair
    const fixed = await retryRollbackVerification(db, { runId: run.runId, actor: ACTOR, sleep, retryDelayMs: 0 });
    expect(fixed.outcome).toBe(RunState.ROLLED_BACK_VERIFIED);

    const next = await runWithRollbackVerification({ ...base(), apply: async () => {}, rollback: undo });
    expect(next.outcome).toBe(RunState.SUCCEEDED);
  });

  it("is a no-op replay once verified", async () => {
    const run = await drifted();
    await undo();
    await retryRollbackVerification(db, { runId: run.runId, actor: ACTOR, sleep, retryDelayMs: 0 });
    const again = await retryRollbackVerification(db, { runId: run.runId, actor: ACTOR });
    expect(again).toMatchObject({ outcome: RunState.ROLLED_BACK_VERIFIED, replayed: true });
  });

  it("re-runs a failed rollback before verifying", async () => {
    const run = await runWithRollbackVerification({
      ...base(),
      apply: async () => { await migrate(); throw new Error("boom"); },
      rollback: async () => { throw new Error("down"); },
      rollbackRetries: 0,
    });
    expect(run.outcome).toBe(RunState.ROLLBACK_FAILED);
    await expectCode(retryRollbackVerification(db, { runId: run.runId, actor: ACTOR }), "VALIDATION_FAILED", "missing_rollback");
    const result = await retryRollbackVerification(db, { runId: run.runId, actor: ACTOR, rollback: undo, sleep, retryDelayMs: 0 });
    expect(result.outcome).toBe(RunState.ROLLED_BACK_VERIFIED);
  });

  it("recovers a run whose runner died mid-flight", async () => {
    const before = await captureFingerprint(db, { targets: ["materials"] });
    db.seed("rollback_verifications", { _id: "dead", name: "add-tier", state: RunState.APPLYING, before, history: [] });
    await migrate(); // the forward step had landed before the crash
    const result = await retryRollbackVerification(db, { runId: "dead", actor: ACTOR, rollback: undo, sleep, retryDelayMs: 0 });
    expect(result.outcome).toBe(RunState.ROLLED_BACK_VERIFIED);
  });

  it("enforces authorization and state", async () => {
    const run = await drifted();
    await expectCode(retryRollbackVerification(db, { runId: run.runId, actor: NOBODY }), "AUTH_FORBIDDEN");
    await expectCode(retryRollbackVerification(db, { runId: "missing", actor: ACTOR }), "NOT_FOUND");
    const ok = await runWithRollbackVerification({ ...base(), name: "fine", apply: async () => {}, rollback: undo });
    await expectCode(retryRollbackVerification(db, { runId: ok.runId, actor: ACTOR }), "CONFLICT_STATE", "not_retryable");
  });
});
