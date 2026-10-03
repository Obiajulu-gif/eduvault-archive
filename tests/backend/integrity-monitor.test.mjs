/**
 * Data Integrity Monitor Tests (Issue #831)
 *
 * Fixture-driven tests that verify the read-only monitor detects EVERY failure
 * category — orphaned, duplicate, stale, inconsistent (and existing missing) —
 * and that running the monitor mutates nothing.
 *
 * The rules under test live in scripts/lib/integrity-rules.mjs, which is
 * side-effect free so it can be imported directly.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  REPORT_CATEGORIES,
  buildCategoryReport,
  resolveStaleThresholds,
  validateIntegrity
} from "../../scripts/lib/integrity-rules.mjs";

// Deterministic clock for stale rules.
const NOW = new Date("2026-01-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const THRESHOLDS = {
  pendingPurchaseHours: 24,
  pendingPurchaseMs: 24 * HOUR_MS,
  deadLetterDays: 7,
  deadLetterMs: 7 * DAY_MS
};

let mongoServer;
let client;
let db;

before(async () => {
  mongoServer = await MongoMemoryServer.create();
  client = new MongoClient(mongoServer.getUri());
  await client.connect();
  db = client.db("integrity_monitor_test");
});

after(async () => {
  await client.close();
  await mongoServer.stop();
});

beforeEach(async () => {
  const collections = await db.listCollections().toArray();
  for (const coll of collections) {
    await db.collection(coll.name).deleteMany({});
  }
});

/** Run the monitor read-only with the deterministic clock. */
function run(overrides = {}) {
  return validateIntegrity(db, {
    now: NOW,
    thresholds: THRESHOLDS,
    ...overrides
  });
}

function violationsOfType(results, type) {
  return results.violations.filter((v) => v.type === type);
}

function violationIds(results) {
  return results.violations.map((v) => v.id);
}

/** Serialize every collection so we can assert the monitor changed nothing. */
async function snapshot() {
  const collections = await db.listCollections().toArray();
  const snap = {};
  for (const coll of collections) {
    const docs = await db.collection(coll.name).find({}).sort({ _id: 1 }).toArray();
    snap[coll.name] = JSON.stringify(docs);
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

async function seedMissing() {
  // Purchase pointing at a material that does not exist.
  await db.collection("purchases").insertOne({
    _id: new ObjectId(),
    buyerAddress: "0xbuyer-missing",
    materialId: new ObjectId().toString(),
    status: "completed",
    transactionHash: "0xtx-missing",
    createdAt: NOW
  });

  // Refund pointing at a purchase that does not exist.
  await db.collection("refund_requests").insertOne({
    _id: new ObjectId(),
    purchaseId: new ObjectId().toString(),
    amount: 100,
    reason: "fixture"
  });
}

async function seedOrphaned() {
  const missingMaterialId = new ObjectId().toString();

  await db.collection("material_history").insertOne({
    _id: new ObjectId(),
    materialId: missingMaterialId,
    version: 3
  });

  await db.collection("saved_materials").insertOne({
    _id: new ObjectId(),
    materialId: missingMaterialId,
    walletAddress: "0xsaver"
  });
}

async function seedDuplicate() {
  await db.collection("users").insertMany([
    { _id: new ObjectId(), walletAddress: "0xdup", uuid: "uuid-dup" },
    { _id: new ObjectId(), walletAddress: "0xdup", uuid: "uuid-b" }
  ]);
  await db.collection("users").insertOne({
    _id: new ObjectId(),
    walletAddress: "0xdup-2",
    uuid: "uuid-dup"
  });
}

async function seedStale() {
  // 1. Pending purchase whose last change is well past the threshold.
  const material = { _id: new ObjectId(), userAddress: "0xcreator", title: "M", visibility: "public" };
  await db.collection("materials").insertOne(material);
  await db.collection("purchases").insertOne({
    _id: new ObjectId(),
    buyerAddress: "0xstale-buyer",
    materialId: material._id.toString(),
    status: "pending",
    createdAt: new Date(NOW.getTime() - 3 * DAY_MS)
  });

  // 2. Unresolved dead-letter event past the threshold.
  await db.collection("dead_letter_events").insertOne({
    _id: "evt-stale",
    status: "retryable",
    retryCount: 4,
    lastError: "boom",
    lastAttemptedAt: new Date(NOW.getTime() - 30 * DAY_MS)
  });

  // 3. Active entitlement whose expiry has passed (with a valid backing
  //    purchase so it is stale, not inconsistent).
  const cacheMaterial = { _id: new ObjectId(), userAddress: "0xcreator", title: "M2", visibility: "public" };
  await db.collection("materials").insertOne(cacheMaterial);
  await db.collection("purchases").insertOne({
    _id: new ObjectId(),
    buyerAddress: "0xexpired-buyer",
    materialId: cacheMaterial._id.toString(),
    status: "completed",
    transactionHash: "0xtx-expired",
    createdAt: new Date(NOW.getTime() - 40 * DAY_MS)
  });
  await db.collection("entitlement_cache").insertOne({
    _id: new ObjectId(),
    materialId: cacheMaterial._id.toString(),
    buyerAddress: "0xexpired-buyer",
    active: true,
    expiresAt: new Date(NOW.getTime() - 2 * DAY_MS)
  });
}

async function seedInconsistent() {
  // Material without a creator.
  await db.collection("materials").insertOne({
    _id: new ObjectId(),
    title: "No creator",
    visibility: "public"
  });

  // Purchase without a buyer address.
  await db.collection("purchases").insertOne({
    _id: new ObjectId(),
    materialId: new ObjectId().toString(),
    status: "pending",
    createdAt: NOW
  });

  // Active entitlement with no completed purchase.
  const material = { _id: new ObjectId(), userAddress: "0xcreator", title: "M3", visibility: "public" };
  await db.collection("materials").insertOne(material);
  await db.collection("entitlement_cache").insertOne({
    _id: new ObjectId(),
    materialId: material._id.toString(),
    buyerAddress: "0xno-purchase",
    active: true
  });
}

async function seedAllCategories() {
  await seedMissing();
  await seedOrphaned();
  await seedDuplicate();
  await seedStale();
  await seedInconsistent();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Data Integrity Monitor (#831)", () => {
  describe("stale threshold configuration", () => {
    it("resolves defaults when env is empty", () => {
      const t = resolveStaleThresholds({});
      assert.strictEqual(t.pendingPurchaseHours, 24);
      assert.strictEqual(t.deadLetterDays, 7);
      assert.strictEqual(t.pendingPurchaseMs, 24 * HOUR_MS);
      assert.strictEqual(t.deadLetterMs, 7 * DAY_MS);
    });

    it("honors env overrides", () => {
      const t = resolveStaleThresholds({
        INTEGRITY_STALE_PENDING_PURCHASE_HOURS: "2",
        INTEGRITY_STALE_DEADLETTER_DAYS: "3"
      });
      assert.strictEqual(t.pendingPurchaseHours, 2);
      assert.strictEqual(t.deadLetterDays, 3);
      assert.strictEqual(t.pendingPurchaseMs, 2 * HOUR_MS);
      assert.strictEqual(t.deadLetterMs, 3 * DAY_MS);
    });

    it("falls back to defaults for invalid values", () => {
      const t = resolveStaleThresholds({
        INTEGRITY_STALE_PENDING_PURCHASE_HOURS: "-5",
        INTEGRITY_STALE_DEADLETTER_DAYS: "not-a-number"
      });
      assert.strictEqual(t.pendingPurchaseHours, 24);
      assert.strictEqual(t.deadLetterDays, 7);
    });
  });

  describe("category detection", () => {
    it("detects missing records", async () => {
      await seedMissing();
      const results = await run();

      const missing = violationsOfType(results, "missing");
      assert.ok(missing.length >= 1, "should detect at least one missing-reference violation");
      assert.ok(violationIds(results).includes("purchases_missing_material"));
      assert.ok(violationIds(results).includes("refund_without_original_purchase"));
    });

    it("detects orphaned records", async () => {
      await seedOrphaned();
      const results = await run();

      const orphaned = violationsOfType(results, "orphaned");
      assert.ok(orphaned.length >= 1, "should detect orphaned records");
      assert.ok(violationIds(results).includes("material_history_missing_material"));
      assert.ok(violationIds(results).includes("saved_materials_missing_material"));
    });

    it("detects duplicate records", async () => {
      await seedDuplicate();
      const results = await run();

      const duplicate = violationsOfType(results, "duplicate");
      assert.ok(duplicate.length >= 1, "should detect duplicate records");
      assert.ok(violationIds(results).includes("duplicate_wallet_addresses"));
      assert.ok(violationIds(results).includes("duplicate_uuids"));
    });

    it("detects stale records", async () => {
      await seedStale();
      const results = await run();

      const stale = violationsOfType(results, "stale");
      assert.ok(stale.length >= 1, "should detect stale records");
      assert.ok(violationIds(results).includes("stale_pending_purchases"));
      assert.ok(violationIds(results).includes("stale_dead_letter_events"));
      assert.ok(violationIds(results).includes("stale_expired_entitlements_active"));
    });

    it("detects inconsistent records", async () => {
      await seedInconsistent();
      const results = await run();

      const inconsistent = violationsOfType(results, "inconsistent");
      assert.ok(inconsistent.length >= 1, "should detect inconsistent records");
      assert.ok(violationIds(results).includes("material_without_creator"));
      assert.ok(violationIds(results).includes("purchase_without_buyer"));
      assert.ok(violationIds(results).includes("active_entitlement_without_purchase"));
    });

    it("reports every category with counts and sample ids", async () => {
      await seedAllCategories();
      const results = await run();
      const report = buildCategoryReport(results);

      assert.deepStrictEqual(
        Object.keys(report.categories).sort(),
        ["duplicate", "inconsistent", "missing", "orphaned", "stale"]
      );

      for (const category of REPORT_CATEGORIES) {
        assert.ok(report.categories[category].count > 0, `${category} should have a count > 0`);
        assert.ok(
          report.categories[category].sampleIds.length > 0,
          `${category} should expose sample ids`
        );
      }

      assert.strictEqual(report.readOnly, true);
      assert.strictEqual(report.clean, false);
    });
  });

  describe("read-only guarantee", () => {
    it("does not mutate any collection while monitoring", async () => {
      await seedAllCategories();
      const before = await snapshot();

      await run();

      const after = await snapshot();
      assert.deepStrictEqual(after, before, "monitor must not change any collection");
    });

    it("does not mutate even when autoRepair is passed", async () => {
      await seedAllCategories();
      const before = await snapshot();

      await run({ autoRepair: true });

      const after = await snapshot();
      assert.deepStrictEqual(after, before, "monitor path must stay read-only");
    });
  });

  describe("valid datasets", () => {
    it("is clean when all records are consistent", async () => {
      const material = {
        _id: new ObjectId(),
        title: "Valid",
        userAddress: "0xcreator",
        visibility: "public",
        price: 10,
        storageKey: "QmValid"
      };
      await db.collection("materials").insertOne(material);
      await db.collection("users").insertOne({
        _id: new ObjectId(),
        walletAddress: "0xunique",
        uuid: "uuid-unique"
      });
      await db.collection("purchases").insertOne({
        _id: new ObjectId(),
        buyerAddress: "0xbuyer",
        materialId: material._id.toString(),
        status: "completed",
        transactionHash: "0xtx",
        createdAt: NOW
      });
      await db.collection("entitlement_cache").insertOne({
        _id: new ObjectId(),
        materialId: material._id.toString(),
        buyerAddress: "0xbuyer",
        active: true
      });

      const results = await run();
      const report = buildCategoryReport(results);

      assert.strictEqual(results.failed, 0, `expected clean run, got: ${JSON.stringify(results.violations)}`);
      assert.strictEqual(report.clean, true);
      for (const category of REPORT_CATEGORIES) {
        assert.strictEqual(report.categories[category].count, 0);
      }
    });
  });
});
