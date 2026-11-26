import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeMongo } from "../../src/lib/migrations/__tests__/fakeMongo.js";
import {
  CURRENT_METADATA_VERSION,
  DEFAULT_METADATA_MIGRATIONS,
  METADATA_MIGRATION_RUNS_COLLECTION,
  METADATA_MIGRATION_SNAPSHOTS_COLLECTION,
  MetadataMigrationState,
  assertMetadataMigrationAuthorized,
  getMaterialMetadataMigrationStatus,
  migrateMaterialMetadata,
  readMaterialMetadata,
  retryMaterialMetadataMigration,
  rollbackMaterialMetadataMigration,
} from "../../src/lib/migrations/materialMetadataMigration.js";

const ADMIN_ACTOR = { id: "admin-1", role: "admin" };
const DEPLOYER_ACTOR = { id: "ops-deployer", role: "deployer" };
const PERMISSION_ACTOR = { id: "ci-bot", role: "service", permissions: ["system:migrate"] };
const VIEWER_ACTOR = { id: "viewer-1", role: "viewer" };
const CREATOR_ACTOR = { id: "creator-1", role: "creator" };
const noopSleep = async () => {};

function createSeededDb() {
  const db = createFakeMongo();
  db.seed(
    "materials",
    {
      _id: "m1",
      title: "Linear Algebra Notes",
      price: 0,
      schemaVersion: 2,
      pricingTier: "free",
      sorobanEntitlementConfig: { contractId: "C1", tokenStandard: "SEP-0041", transferrable: true },
      rightsMetadata: { commercialUse: false, educationalOnly: true, distributionAllowed: false },
      category: "math",
      subject: "algebra",
      level: "undergraduate",
      tags: "Math, Algebra, math ",
    },
    {
      _id: "m2",
      title: "Applied Cryptography",
      price: 25,
      schemaVersion: 2,
      pricingTier: "premium",
      rightsMetadata: { commercialUse: true, educationalOnly: false, distributionAllowed: true },
      category: "computer-science",
      subject: "security",
      tags: ["Crypto", "Security"],
      metadataVersion: 1,
    },
    {
      _id: "m3",
      title: "Soroban Smart Contracts",
      price: 12,
      schemaVersion: 2,
      category: "blockchain",
      metadataVersion: 2,
      metadata: {
        tags: ["stellar", "soroban"],
        language: "en",
        taxonomy: { category: "blockchain", subject: "smart-contracts", level: "intermediate" },
      },
    }
  );
  return db;
}

// ── Authorization Paths ──────────────────────────────────────────────────────

test("authorization: allows privileged roles/permissions and rejects unauthorized actors", async () => {
  assert.doesNotThrow(() => assertMetadataMigrationAuthorized(ADMIN_ACTOR));
  assert.doesNotThrow(() => assertMetadataMigrationAuthorized(DEPLOYER_ACTOR));
  assert.doesNotThrow(() => assertMetadataMigrationAuthorized({ id: "rel-1", role: "release_engineer" }));
  assert.doesNotThrow(() => assertMetadataMigrationAuthorized(PERMISSION_ACTOR));

  for (const badActor of [null, undefined, {}, VIEWER_ACTOR, CREATOR_ACTOR]) {
    assert.throws(
      () => assertMetadataMigrationAuthorized(badActor),
      (err) => err.code === "AUTH_FORBIDDEN" && err.status === 403
    );
  }

  const db = createSeededDb();
  await assert.rejects(
    () => migrateMaterialMetadata(db, { actor: CREATOR_ACTOR, sleep: noopSleep }),
    (err) => err.code === "AUTH_FORBIDDEN"
  );
  await assert.rejects(
    () => rollbackMaterialMetadataMigration(db, { runId: "run-1", actor: VIEWER_ACTOR, sleep: noopSleep }),
    (err) => err.code === "AUTH_FORBIDDEN"
  );
  await assert.rejects(
    () => retryMaterialMetadataMigration(db, { runId: "run-1", actor: VIEWER_ACTOR, sleep: noopSleep }),
    (err) => err.code === "AUTH_FORBIDDEN"
  );

  // Unauthorized attempts must not mutate materials or create run records.
  assert.equal(db.all(METADATA_MIGRATION_RUNS_COLLECTION).length, 0);
  assert.equal(db.get("materials", "m1").metadataVersion, undefined);
});

// ── Normal Paths ─────────────────────────────────────────────────────────────

test("normal path: dry-run previews multi-hop diffs without mutating DB", async () => {
  const db = createSeededDb();
  const preview = await migrateMaterialMetadata(db, {
    actor: DEPLOYER_ACTOR,
    targetVersion: CURRENT_METADATA_VERSION,
    dryRun: true,
    sleep: noopSleep,
  });

  assert.equal(preview.dryRun, true);
  assert.equal(preview.targetVersion, 3);
  assert.equal(preview.eligibleCount, 3);
  assert.equal(preview.migratedCount, 0);
  assert.equal(preview.validationErrors.length, 0);
  assert.equal(preview.sampleDiffs.length, 3);
  assert.deepEqual(preview.sampleDiffs[0].after.metadata.tags, ["math", "algebra"]);

  // No DB side effects on dry-run.
  assert.equal(db.all(METADATA_MIGRATION_RUNS_COLLECTION).length, 0);
  assert.equal(db.all(METADATA_MIGRATION_SNAPSHOTS_COLLECTION).length, 0);
  assert.equal(db.get("materials", "m1").metadataVersion, undefined);
});

test("normal path: multi-hop forward migration v1->v3 preserves existing catalog contracts", async () => {
  const db = createSeededDb();
  const result = await migrateMaterialMetadata(db, {
    actor: ADMIN_ACTOR,
    runId: "run-v3-normal",
    targetVersion: 3,
    batchSize: 2,
    sleep: noopSleep,
  });

  assert.equal(result.state, MetadataMigrationState.COMPLETED);
  assert.equal(result.replayed, false);
  assert.equal(result.migratedCount, 3);
  assert.equal(result.failedCount, 0);

  const m1 = db.get("materials", "m1");
  assert.equal(m1.metadataVersion, 3);
  assert.deepEqual(m1.metadata.tags, ["math", "algebra"]);
  assert.equal(m1.metadata.language, "en");
  assert.deepEqual(m1.metadata.taxonomy, {
    category: "math",
    subject: "algebra",
    level: "undergraduate",
  });
  assert.equal(m1.metadata.licensing.licenseType, "educational");
  assert.equal(m1.metadata.licensing.commercialAllowed, false);
  assert.equal(m1.metadata.checksum.length, 64);

  // Existing v2 catalog fields & legacy fields are preserved intact.
  assert.equal(m1.schemaVersion, 2);
  assert.equal(m1.pricingTier, "free");
  assert.equal(m1.sorobanEntitlementConfig.contractId, "C1");
  assert.equal(m1.category, "math");
  assert.equal(m1.tags, "Math, Algebra, math ");

  const m2 = db.get("materials", "m2");
  assert.equal(m2.metadataVersion, 3);
  assert.equal(m2.metadata.licensing.licenseType, "commercial");
  assert.equal(m2.metadata.licensing.commercialAllowed, true);

  // Idempotent replay with same runId returns existing result without rewriting.
  const replay = await migrateMaterialMetadata(db, {
    actor: ADMIN_ACTOR,
    runId: "run-v3-normal",
    targetVersion: 3,
    sleep: noopSleep,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, MetadataMigrationState.COMPLETED);
  assert.equal(replay.migratedCount, 3);

  const status = await getMaterialMetadataMigrationStatus(db);
  assert.equal(status.totalMaterials, 3);
  assert.deepEqual(status.versionCounts, { 3: 3 });
  assert.equal(status.unresolvedRunCount, 0);
});

test("normal path: dual-read helper upgrades legacy docs and downgrades newer docs in-memory", () => {
  const legacy = { _id: "m1", title: "Legacy", category: "science", tags: "Physics, Optics" };
  const asV3 = readMaterialMetadata(legacy, { targetVersion: 3 });
  assert.equal(asV3.metadataVersion, 3);
  assert.deepEqual(asV3.metadata.tags, ["physics", "optics"]);
  assert.equal(asV3.metadata.licensing.licenseType, "educational");
  // Original document is not mutated.
  assert.equal(legacy.metadataVersion, undefined);

  const backToV1 = readMaterialMetadata(asV3, { targetVersion: 1 });
  assert.equal(backToV1.metadataVersion, 1);
  assert.equal(backToV1.metadata, undefined);

  assert.throws(
    () => readMaterialMetadata(legacy, { targetVersion: 99 }),
    (err) => err.code === "VALIDATION_FIELD"
  );
});

// ── Failure & Automatic Rollback Paths ───────────────────────────────────────

test("failure path: mid-batch validation error triggers automatic lossless rollback", async () => {
  const db = createSeededDb();
  const snapshotBeforeM1 = structuredClone(db.get("materials", "m1"));
  const snapshotBeforeM2 = structuredClone(db.get("materials", "m2"));
  const snapshotBeforeM3 = structuredClone(db.get("materials", "m3"));

  const failingRegistry = {
    ...DEFAULT_METADATA_MIGRATIONS,
    3: {
      ...DEFAULT_METADATA_MIGRATIONS[3],
      validate(doc) {
        // Succeed for m1, fail for m2 to prove earlier docs in batch are rolled back.
        if (doc._id === "m2") return false;
        return DEFAULT_METADATA_MIGRATIONS[3].validate(doc);
      },
    },
  };

  const result = await migrateMaterialMetadata(db, {
    actor: DEPLOYER_ACTOR,
    runId: "run-auto-rollback",
    targetVersion: 3,
    registry: failingRegistry,
    autoRollback: true,
    sleep: noopSleep,
  });

  assert.equal(result.state, MetadataMigrationState.ROLLED_BACK);
  assert.equal(result.failedCount, 1);
  assert.equal(result.failure.materialId, "m2");
  assert.equal(result.rollback.state, MetadataMigrationState.ROLLED_BACK);
  assert.equal(result.rollback.rolledBackCount, 1);

  // Every document matches its exact pre-migration state (including absent metadataVersion on m1).
  assert.deepEqual(db.get("materials", "m1"), snapshotBeforeM1);
  assert.deepEqual(db.get("materials", "m2"), snapshotBeforeM2);
  assert.deepEqual(db.get("materials", "m3"), snapshotBeforeM3);
});

test("failure path: autoRollback=false leaves run FAILED and blocks new runs until resolved", async () => {
  const db = createSeededDb();
  let shouldFail = true;
  const flakyRegistry = {
    ...DEFAULT_METADATA_MIGRATIONS,
    3: {
      ...DEFAULT_METADATA_MIGRATIONS[3],
      up(doc) {
        if (shouldFail && doc._id === "m2") {
          const err = new Error("Simulated transform failure on m2");
          err.retryable = false;
          throw err;
        }
        return DEFAULT_METADATA_MIGRATIONS[3].up(doc);
      },
    },
  };

  const failedRun = await migrateMaterialMetadata(db, {
    actor: ADMIN_ACTOR,
    runId: "run-manual-recovery",
    targetVersion: 3,
    registry: flakyRegistry,
    autoRollback: false,
    sleep: noopSleep,
  });

  assert.equal(failedRun.state, MetadataMigrationState.FAILED);
  assert.equal(failedRun.migratedCount, 1);
  assert.equal(db.get("materials", "m1").metadataVersion, 3);
  assert.equal(db.get("materials", "m2").metadataVersion, 1);

  // Starting a brand-new unrelated run must be blocked while unresolved.
  await assert.rejects(
    () =>
      migrateMaterialMetadata(db, {
        actor: ADMIN_ACTOR,
        runId: "run-blocked",
        targetVersion: 3,
        sleep: noopSleep,
      }),
    (err) => err.code === "CONFLICT_STATE"
  );

  // Fix the issue and retry the failed run -> resumes from m2 and m3 cleanly.
  shouldFail = false;
  const retried = await retryMaterialMetadataMigration(db, {
    runId: "run-manual-recovery",
    actor: ADMIN_ACTOR,
    registry: flakyRegistry,
    sleep: noopSleep,
  });

  assert.equal(retried.state, MetadataMigrationState.COMPLETED);
  assert.equal(retried.migratedCount, 3);
  assert.equal(db.get("materials", "m1").metadataVersion, 3);
  assert.equal(db.get("materials", "m2").metadataVersion, 3);
  assert.equal(db.get("materials", "m3").metadataVersion, 3);
});

// ── Retry Paths ──────────────────────────────────────────────────────────────

test("retry path: transient DB write failure recovers automatically within maxRetries", async () => {
  const db = createSeededDb();
  // Fail the first 2 replaceOne calls on materials, then succeed on 3rd attempt.
  db.failNext("materials", "replaceOne", 2, new Error("Transient MongoDB primary stepdown"));

  const result = await migrateMaterialMetadata(db, {
    actor: DEPLOYER_ACTOR,
    runId: "run-transient-retry",
    targetVersion: 3,
    maxRetries: 2,
    retryDelayMs: 1,
    sleep: noopSleep,
  });

  assert.equal(result.state, MetadataMigrationState.COMPLETED);
  assert.equal(result.migratedCount, 3);
  assert.equal(db.get("materials", "m1").metadataVersion, 3);
});

test("retry path: rollback failure enters ROLLBACK_FAILED and recovers via operator retry", async () => {
  const db = createSeededDb();
  const beforeM1 = structuredClone(db.get("materials", "m1"));

  await migrateMaterialMetadata(db, {
    actor: ADMIN_ACTOR,
    runId: "run-rollback-retry",
    targetVersion: 3,
    sleep: noopSleep,
  });

  // Simulate persistent outage during rollback (exceeds maxRetries=1).
  db.failNext("materials", "replaceOne", 5, new Error("Replica set unreachable"));

  const failedRollback = await rollbackMaterialMetadataMigration(db, {
    runId: "run-rollback-retry",
    actor: ADMIN_ACTOR,
    maxRetries: 1,
    sleep: noopSleep,
  });

  assert.equal(failedRollback.state, MetadataMigrationState.ROLLBACK_FAILED);
  assert.ok(failedRollback.failedRollbacks.length > 0);

  // New forward migration is blocked while ROLLBACK_FAILED.
  await assert.rejects(
    () => migrateMaterialMetadata(db, { actor: ADMIN_ACTOR, runId: "run-after-failed-rb", sleep: noopSleep }),
    (err) => err.code === "CONFLICT_STATE"
  );

  // Clear remaining failures by retrying once DB recovers.
  // Exhaust any remaining simulated failures on a fresh call after outage clears:
  db.failNext("materials", "replaceOne", 0);
  // Drain remaining 3 queued failures by allowing maxRetries=4 on retry.
  const recovered = await retryMaterialMetadataMigration(db, {
    runId: "run-rollback-retry",
    actor: ADMIN_ACTOR,
    maxRetries: 4,
    sleep: noopSleep,
  });

  assert.equal(recovered.state, MetadataMigrationState.ROLLED_BACK);
  assert.equal(recovered.rolledBackCount, 3);
  assert.deepEqual(db.get("materials", "m1"), beforeM1);

  // Re-retrying a completed rollback is idempotent.
  const replayed = await retryMaterialMetadataMigration(db, {
    runId: "run-rollback-retry",
    actor: ADMIN_ACTOR,
    sleep: noopSleep,
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.state, MetadataMigrationState.ROLLED_BACK);
});

// ── Explicit Rollback & Concurrent Edit Edge Cases ───────────────────────────

test("explicit rollback: detects concurrent metadata edits and requires force=true to override", async () => {
  const db = createSeededDb();
  const beforeM1 = structuredClone(db.get("materials", "m1"));
  const beforeM2 = structuredClone(db.get("materials", "m2"));

  await migrateMaterialMetadata(db, {
    actor: ADMIN_ACTOR,
    runId: "run-drift-check",
    targetVersion: 3,
    sleep: noopSleep,
  });

  // Simulate a creator editing m2's metadata after migration completed.
  const editedM2 = db.get("materials", "m2");
  editedM2.metadata.tags.push("post-migration-edit");
  db.put("materials", editedM2);

  // Rollback without force: reverts m1 & m3, protects m2 with conflict report.
  const partial = await rollbackMaterialMetadataMigration(db, {
    runId: "run-drift-check",
    actor: ADMIN_ACTOR,
    force: false,
    sleep: noopSleep,
  });

  assert.equal(partial.state, MetadataMigrationState.PARTIALLY_ROLLED_BACK);
  assert.equal(partial.rolledBackCount, 2);
  assert.equal(partial.conflicts.length, 1);
  assert.equal(partial.conflicts[0].materialId, "m2");
  assert.equal(partial.conflicts[0].reason, "metadata_modified_after_migration");
  assert.deepEqual(db.get("materials", "m1"), beforeM1);
  assert.ok(db.get("materials", "m2").metadata.tags.includes("post-migration-edit"));

  // Operator explicitly forces rollback via retry with force=true.
  const forced = await retryMaterialMetadataMigration(db, {
    runId: "run-drift-check",
    actor: ADMIN_ACTOR,
    force: true,
    sleep: noopSleep,
  });

  assert.equal(forced.state, MetadataMigrationState.ROLLED_BACK);
  assert.equal(forced.rolledBackCount, 3);
  assert.equal(forced.conflicts.length, 0);
  assert.deepEqual(db.get("materials", "m2"), beforeM2);
});

test("edge cases: rejects invalid targetVersion and active concurrent run", async () => {
  const db = createSeededDb();

  await assert.rejects(
    () => migrateMaterialMetadata(db, { actor: ADMIN_ACTOR, targetVersion: 99, sleep: noopSleep }),
    (err) => err.code === "VALIDATION_FIELD"
  );

  // Seed an active RUNNING run to simulate concurrent operator invocation.
  db.seed(METADATA_MIGRATION_RUNS_COLLECTION, {
    _id: "active-run",
    state: MetadataMigrationState.RUNNING,
    targetVersion: 3,
    startedAt: new Date(),
  });

  await assert.rejects(
    () => migrateMaterialMetadata(db, { actor: ADMIN_ACTOR, runId: "second-run", sleep: noopSleep }),
    (err) => err.code === "CONFLICT_IN_PROGRESS"
  );

  await assert.rejects(
    () => rollbackMaterialMetadataMigration(db, { runId: "active-run", actor: ADMIN_ACTOR, sleep: noopSleep }),
    (err) => err.code === "CONFLICT_IN_PROGRESS"
  );
});
