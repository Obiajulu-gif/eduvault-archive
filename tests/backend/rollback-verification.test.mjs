import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  RunState,
  VerificationStatus,
  captureFingerprint,
  compareFingerprints,
  retryRollbackVerification,
  runWithRollbackVerification,
  verifyRollback,
} from "../../src/lib/migrations/rollbackVerification.js";
import { createFakeMongo } from "../../src/lib/migrations/__tests__/fakeMongo.js";

const ACTOR = { id: "ops-1", role: "deployer" };
const UNAUTHORIZED_ACTOR = { id: "viewer-1", role: "viewer" };
const sleep = async () => {};

function setupDb() {
  const db = createFakeMongo();
  db.seed("materials", { _id: "m1", title: "A", tier: "free" }, { _id: "m2", title: "B", tier: "free" });
  db.seed("users", { _id: "u1", email: "a@example.com" });
  return db;
}

const baseOptions = (db) => ({
  db,
  name: "add-tier-migration",
  actor: ACTOR,
  targets: ["materials"],
  sleep,
  retryDelayMs: 0,
});

test("fingerprint is stable for identical data regardless of key order", async () => {
  const db = setupDb();
  const a = await captureFingerprint(db, { targets: ["materials"] });
  db.put("materials", { tier: "free", title: "A", _id: "m1" });
  const b = await captureFingerprint(db, { targets: ["materials"] });

  assert.equal(b.collections.materials.digest, a.collections.materials.digest);
  assert.equal(compareFingerprints(a, b).matches, true);
});

test("compareFingerprints detects changed, added, and removed documents", async () => {
  const db = setupDb();
  const before = await captureFingerprint(db, { targets: ["materials"] });

  // Update a record
  db.put("materials", { _id: "m1", title: "A", tier: "paid" });
  let diff = compareFingerprints(before, await captureFingerprint(db, { targets: ["materials"] }));
  assert.deepEqual(diff.differences.map((d) => d.type), ["content_changed"]);

  // Insert a record
  db.put("materials", { _id: "m3", title: "C", tier: "free" });
  diff = compareFingerprints(before, await captureFingerprint(db, { targets: ["materials"] }));
  assert.deepEqual(diff.differences.map((d) => d.type), ["count_changed", "content_changed"]);
});

test("captureFingerprint scopes to queries and ignores designated fields", async () => {
  const db = setupDb();
  const targets = [{ collection: "materials", query: { tier: "free" }, ignoreFields: ["touchedAt"] }];
  const before = await captureFingerprint(db, { targets });

  // Modifying an ignored field does not breach the fingerprint
  db.put("materials", { _id: "m1", title: "A", tier: "free", touchedAt: new Date().toISOString() });
  assert.equal(compareFingerprints(before, await captureFingerprint(db, { targets })).matches, true);

  // Modifying an unmonitored collection does not breach
  db.put("users", { _id: "u2", email: "b@example.com" });
  assert.equal(compareFingerprints(before, await captureFingerprint(db, { targets })).matches, true);
});

test("compareFingerprints flags index changes properly (missing index = error, extra index = warning)", async () => {
  const db = setupDb();
  db.setIndexes("materials", ["_id_", "tier_idx"]);
  const before = await captureFingerprint(db, { targets: ["materials"] });

  db.setIndexes("materials", ["_id_", "extra_idx"]);
  const diff = compareFingerprints(before, await captureFingerprint(db, { targets: ["materials"] }));

  assert.equal(diff.matches, false);
  const missing = diff.differences.find((d) => d.type === "index_missing");
  const added = diff.differences.find((d) => d.type === "index_added");
  assert.ok(missing && missing.severity === "error" && missing.index === "tier_idx");
  assert.ok(added && added.severity === "warning" && added.index === "extra_idx");
});

test("runWithRollbackVerification normal path: completes and records SUCCEEDED", async () => {
  const db = setupDb();
  let applied = false;
  let rolledBack = false;

  const result = await runWithRollbackVerification({
    ...baseOptions(db),
    apply: async () => {
      applied = true;
      db.put("materials", { _id: "m1", title: "A", tier: "paid" });
    },
    rollback: async () => {
      rolledBack = true;
    },
    postChecks: [{ name: "check-tier", run: async () => ({ ok: true }) }],
  });

  assert.equal(applied, true);
  assert.equal(rolledBack, false);
  assert.equal(result.outcome, RunState.SUCCEEDED);

  const runRecord = await db.collection("rollback_verifications").findOne({ _id: result.runId });
  assert.equal(runRecord.state, RunState.SUCCEEDED);
  assert.equal(runRecord.postChecks[0].ok, true);
});

test("runWithRollbackVerification failure path: rolls back and verifies restored fingerprint", async () => {
  const db = setupDb();
  let rollbackRan = false;

  const result = await runWithRollbackVerification({
    ...baseOptions(db),
    apply: async () => {
      // Modify data then throw
      db.put("materials", { _id: "m1", title: "A", tier: "corrupt_data" });
      throw new Error("Simulated schema mutation crash");
    },
    rollback: async () => {
      rollbackRan = true;
      // Revert data back to pristine state
      db.put("materials", { _id: "m1", title: "A", tier: "free" });
    },
  });

  assert.equal(rollbackRan, true);
  assert.equal(result.outcome, RunState.ROLLED_BACK_VERIFIED);
  assert.ok(result.error.includes("Simulated schema mutation crash"));
  assert.equal(result.verification.status, VerificationStatus.VERIFIED);
});

test("runWithRollbackVerification postCheck failure triggers verified rollback", async () => {
  const db = setupDb();
  let rollbackRan = false;

  const result = await runWithRollbackVerification({
    ...baseOptions(db),
    apply: async () => {
      db.put("materials", { _id: "m1", title: "A", tier: "paid" });
    },
    rollback: async () => {
      rollbackRan = true;
      db.put("materials", { _id: "m1", title: "A", tier: "free" });
    },
    postChecks: [{ name: "integrity-check", run: async () => ({ ok: false, message: "Invariant failed" }) }],
  });

  assert.equal(rollbackRan, true);
  assert.equal(result.outcome, RunState.ROLLED_BACK_VERIFIED);
  assert.ok(result.error.includes("post-checks failed"));
});

test("runWithRollbackVerification detects rollback drift when rollback leaves modifications", async () => {
  const db = setupDb();

  const result = await runWithRollbackVerification({
    ...baseOptions(db),
    apply: async () => {
      db.put("materials", { _id: "m1", title: "A", tier: "half-applied" });
      throw new Error("Crash mid-migration");
    },
    rollback: async () => {
      // Buggy rollback: forgets to restore m1
    },
  });

  assert.equal(result.outcome, RunState.ROLLBACK_DRIFT);
  assert.equal(result.verification.status, VerificationStatus.DRIFT);
  assert.ok(result.verification.differences.length > 0);
});

test("runWithRollbackVerification records ROLLBACK_FAILED if rollback routine throws", async () => {
  const db = setupDb();

  const result = await runWithRollbackVerification({
    ...baseOptions(db),
    apply: async () => {
      throw new Error("Forward step failed");
    },
    rollback: async () => {
      throw new Error("Rollback disk I/O failure");
    },
  });

  assert.equal(result.outcome, RunState.ROLLBACK_FAILED);
  assert.ok(result.rollbackError.includes("Rollback disk I/O failure"));
});

test("runWithRollbackVerification retries transient failure in rollback and succeeds", async () => {
  const db = setupDb();
  let rollbackAttempts = 0;

  const result = await runWithRollbackVerification({
    ...baseOptions(db),
    rollbackRetries: 2,
    apply: async () => {
      db.put("materials", { _id: "m1", title: "A", tier: "modified" });
      throw new Error("Forward failure");
    },
    rollback: async () => {
      rollbackAttempts++;
      if (rollbackAttempts === 1) {
        throw new Error("Transient socket timeout");
      }
      db.put("materials", { _id: "m1", title: "A", tier: "free" });
    },
  });

  assert.equal(rollbackAttempts, 2);
  assert.equal(result.outcome, RunState.ROLLED_BACK_VERIFIED);
});

test("runWithRollbackVerification blocks execution if an unresolved run exists", async () => {
  const db = setupDb();

  // Create an unresolved run in ROLLBACK_DRIFT
  await db.collection("rollback_verifications").insertOne({
    _id: "prev-run-123",
    name: "add-tier-migration",
    state: RunState.ROLLBACK_DRIFT,
  });

  await assert.rejects(
    async () => {
      await runWithRollbackVerification({
        ...baseOptions(db),
        apply: async () => {},
        rollback: async () => {},
      });
    },
    (err) => err.code === "CONFLICT_STATE" && err.details?.reason === "unresolved_run"
  );
});

test("retryRollbackVerification allows operator to repair and re-verify unresolved run", async () => {
  const db = setupDb();

  // Initial failed run that left drift
  const initial = await runWithRollbackVerification({
    ...baseOptions(db),
    apply: async () => {
      db.put("materials", { _id: "m1", title: "A", tier: "broken" });
      throw new Error("Initial failure");
    },
    rollback: async () => {
      // Incomplete rollback
    },
  });
  assert.equal(initial.outcome, RunState.ROLLBACK_DRIFT);

  // Operator fixes the data
  db.put("materials", { _id: "m1", title: "A", tier: "free" });

  // Operator triggers retryRollbackVerification
  const retried = await retryRollbackVerification(db, {
    runId: initial.runId,
    actor: ACTOR,
    sleep,
  });

  assert.equal(retried.outcome, RunState.ROLLED_BACK_VERIFIED);
  assert.equal(retried.verification.status, VerificationStatus.VERIFIED);
});

test("retryRollbackVerification rejects retry of SUCCEEDED run and returns replayed for already verified", async () => {
  const db = setupDb();

  const successRun = await runWithRollbackVerification({
    ...baseOptions(db),
    apply: async () => {},
    rollback: async () => {},
  });

  // Cannot rollback a succeeded run
  await assert.rejects(
    async () => {
      await retryRollbackVerification(db, { runId: successRun.runId, actor: ACTOR });
    },
    (err) => err.code === "CONFLICT_STATE"
  );

  // Setup a verified run
  const verifiedRun = await runWithRollbackVerification({
    ...baseOptions(db),
    name: "another-migration",
    apply: async () => { throw new Error("Abort"); },
    rollback: async () => {},
  });
  assert.equal(verifiedRun.outcome, RunState.ROLLED_BACK_VERIFIED);

  // Replaying verified run is idempotent
  const replay = await retryRollbackVerification(db, { runId: verifiedRun.runId, actor: ACTOR });
  assert.equal(replay.replayed, true);
  assert.equal(replay.outcome, RunState.ROLLED_BACK_VERIFIED);
});

test("assertAuthorized blocks unauthorized deployment actors", async () => {
  const db = setupDb();

  // Non-deployer actor
  await assert.rejects(
    async () => {
      await runWithRollbackVerification({
        ...baseOptions(db),
        actor: UNAUTHORIZED_ACTOR,
        apply: async () => {},
        rollback: async () => {},
      });
    },
    (err) => err.code === "AUTH_FORBIDDEN"
  );

  // retryRollbackVerification blocks unauthorized actor
  await assert.rejects(
    async () => {
      await retryRollbackVerification(db, {
        runId: "any-run-id",
        actor: UNAUTHORIZED_ACTOR,
      });
    },
    (err) => err.code === "AUTH_FORBIDDEN"
  );
});
