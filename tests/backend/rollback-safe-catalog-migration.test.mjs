import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeMongo } from "../../src/lib/migrations/__tests__/fakeMongo.js";
import {
  executeRollbackSafeCatalogMigration,
  verifyCatalogSchemaConsistency,
  ensureMigrationAuthorization,
} from "../../src/lib/migrations/rollbackSafeCatalogMigration.js";
import { migrationV2 } from "../../src/lib/migrations/catalogMigrationFramework.js";
import { RunState, VerificationStatus } from "../../src/lib/migrations/rollbackVerification.js";

const AUTHORIZED_ACTOR = { id: "ops-deployer", role: "deployer" };
const UNAUTHORIZED_ACTOR = { id: "viewer-guest", role: "viewer" };
const sleep = async () => {};

function setupCatalogDb() {
  const db = createFakeMongo();
  db.seed(
    "materials",
    { _id: "m1", title: "Algebra 101", price: 0, schemaVersion: 1 },
    { _id: "m2", title: "Physics Deep Dive", price: 10, schemaVersion: 1 },
    { _id: "m3", title: "Advanced Quantum", price: 50, schemaVersion: 1 }
  );
  return db;
}

test("authorization: rejects unauthorized operators and accepts deployers/admins", () => {
  assert.throws(
    () => ensureMigrationAuthorization(UNAUTHORIZED_ACTOR),
    (err) => err.code === "AUTH_FORBIDDEN"
  );

  assert.doesNotThrow(() => ensureMigrationAuthorization(AUTHORIZED_ACTOR));
  assert.doesNotThrow(() => ensureMigrationAuthorization({ role: "admin" }));
  assert.doesNotThrow(() => ensureMigrationAuthorization({ permissions: ["system:migrate"] }));
});

test("verify-only mode: reports unmigrated documents and schema consistency", async () => {
  const db = setupCatalogDb();

  const reportBefore = await verifyCatalogSchemaConsistency(db, migrationV2);
  assert.equal(reportBefore.ok, false);
  assert.equal(reportBefore.unmigratedCount, 3);
  assert.equal(reportBefore.migratedCount, 0);

  // Run dry run
  const dryRunResult = await executeRollbackSafeCatalogMigration({
    db,
    migrationDef: migrationV2,
    options: {
      actor: AUTHORIZED_ACTOR,
      dryRun: true,
    },
  });
  assert.equal(dryRunResult.dryRun, true);
  assert.equal(dryRunResult.processedCount, 3);

  // Materials must still be unmigrated
  const materialsColl = db.collection("materials");
  const m1 = await materialsColl.findOne({ _id: "m1" });
  assert.equal(m1.schemaVersion, 1);
  assert.equal(m1.pricingTier, undefined);
});

test("forward migration: applies schema v2 with rollback verification and succeeds", async () => {
  const db = setupCatalogDb();

  const result = await executeRollbackSafeCatalogMigration({
    db,
    migrationDef: migrationV2,
    options: {
      actor: AUTHORIZED_ACTOR,
      sleep,
    },
  });

  assert.equal(result.outcome, RunState.SUCCEEDED);

  const materialsColl = db.collection("materials");
  const m1 = await materialsColl.findOne({ _id: "m1" });
  assert.equal(m1.schemaVersion, 2);
  assert.equal(m1.pricingTier, "free");
  assert.ok(m1.sorobanEntitlementConfig);

  const m3 = await materialsColl.findOne({ _id: "m3" });
  assert.equal(m3.schemaVersion, 2);
  assert.equal(m3.pricingTier, "premium");

  const consistency = await verifyCatalogSchemaConsistency(db, migrationV2);
  assert.equal(consistency.ok, true);
  assert.equal(consistency.unmigratedCount, 0);
  assert.equal(consistency.migratedCount, 3);
});

test("auto-rollback: automatically rolls back and proves data identity when apply fails", async () => {
  const db = setupCatalogDb();

  // Create a flawed migration definition where post-validation will fail
  const failingMigrationDef = {
    ...migrationV2,
    name: "failing_migration_test",
    validate: () => false, // triggers post-check failure
  };

  const result = await executeRollbackSafeCatalogMigration({
    db,
    migrationDef: failingMigrationDef,
    options: {
      actor: AUTHORIZED_ACTOR,
      sleep,
    },
  });

  // Rollback should have executed and proven identical state
  assert.equal(result.outcome, RunState.ROLLED_BACK_VERIFIED);
  assert.equal(result.verification.status, VerificationStatus.VERIFIED);

  // Materials must have reverted to pre-migration shape
  const materialsColl = db.collection("materials");
  const m1 = await materialsColl.findOne({ _id: "m1" });
  assert.equal(m1.schemaVersion, 1);
  assert.equal(m1.pricingTier, undefined);
});

test("explicit rollback: safely reverts schema v2 back to legacy v1", async () => {
  const db = setupCatalogDb();

  // 1. Forward migrate
  await executeRollbackSafeCatalogMigration({
    db,
    migrationDef: migrationV2,
    options: { actor: AUTHORIZED_ACTOR, sleep },
  });

  // 2. Explicit rollback
  const rollbackResult = await executeRollbackSafeCatalogMigration({
    db,
    migrationDef: migrationV2,
    options: {
      actor: AUTHORIZED_ACTOR,
      rollback: true,
      sleep,
    },
  });

  assert.equal(rollbackResult.outcome, RunState.SUCCEEDED);

  const materialsColl = db.collection("materials");
  const m1 = await materialsColl.findOne({ _id: "m1" });
  assert.equal(m1.schemaVersion, 1);
  assert.equal(m1.pricingTier, undefined);
  assert.equal(m1.sorobanEntitlementConfig, undefined);
});
