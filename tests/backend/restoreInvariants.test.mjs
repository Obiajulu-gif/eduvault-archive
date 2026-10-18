/**
 * Tests for snapshot restore invariant verification (#snapshot-restore).
 *
 * These pin the acceptance criteria: restores are checked against invariants,
 * derived views can be rebuilt, and mismatches fail loudly with repair steps.
 * A hand-rolled in-memory Mongo fake keeps the tests deterministic (matching
 * the convention used by tests/backend/restore-verification.test.mjs).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  RESTORE_VIOLATION_CODES,
  buildRepairSteps,
  rebuildEntitlementCache,
  rebuildSearchProjections,
  repairIndexes,
  runRestoreVerification,
  verifyAuditLedger,
  verifyEntitlementDerivedView,
  verifyIndexes,
  verifySearchProjection,
} from "../../src/lib/ops/restoreVerification.js";
import { appendAuditRecord } from "../../src/lib/backend/auditLedger.js";
import { COLLECTIONS, REQUIRED_INDEXES, TTL_INDEXES } from "../../src/lib/backend/schemaContracts.js";

// ---------------------------------------------------------------------------
// In-memory MongoDB fake (find/insert/update/delete/listIndexes/createIndex)
// ---------------------------------------------------------------------------

function compareValues(a, b) {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, condition]) => {
    const value = doc[key];
    if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
      if ("$in" in condition) return condition.$in.some((candidate) => String(candidate) === String(value));
      if ("$exists" in condition) return condition.$exists ? value !== undefined : value === undefined;
      if ("$ne" in condition) return String(value) !== String(condition.$ne);
      if ("$lte" in condition) return compareValues(value, condition.$lte) <= 0;
      if ("$lt" in condition) return compareValues(value, condition.$lt) < 0;
      if ("$gt" in condition) return compareValues(value, condition.$gt) > 0;
      if ("$gte" in condition) return compareValues(value, condition.$gte) >= 0;
    }
    return String(value) === String(condition);
  });
}

function keyTuple(keyPattern) {
  return Object.entries(keyPattern || {})
    .map(([field, direction]) => `${field}:${direction}`)
    .join(",");
}

class FakeCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
    this.indexDefs = [{ key: { _id: 1 }, name: "_id_1" }];
    this.registered = false;
  }

  cursor(docs) {
    let result = [...docs];
    return {
      sort(spec) {
        const [field, direction] = Object.entries(spec)[0] || ["_id", 1];
        result.sort((a, b) => (compareValues(a[field], b[field]) || 0) * direction);
        return this;
      },
      limit(count) {
        result = result.slice(0, count);
        return this;
      },
      async toArray() {
        return result;
      },
      async close() {},
      async *[Symbol.asyncIterator]() {
        for (const doc of result) yield doc;
      },
    };
  }

  find(query = {}) {
    return this.cursor(this.docs.filter((doc) => matches(doc, query)));
  }

  async findOne(query = {}) {
    return this.docs.find((doc) => matches(doc, query)) || null;
  }

  async insertOne(doc) {
    if (doc.operationId && this.docs.some((existing) => existing.operationId === doc.operationId)) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    const stored = { _id: doc._id ?? `${this.name}-${this.docs.length + 1}`, ...doc };
    this.docs.push(stored);
    return { insertedId: stored._id };
  }

  async insertMany(docs) {
    for (const doc of docs) {
      this.docs.push({ _id: doc._id ?? `${this.name}-${this.docs.length + 1}`, ...doc });
    }
    return { insertedCount: docs.length };
  }

  async deleteMany(query = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !matches(doc, query));
    return { deletedCount: before - this.docs.length };
  }

  async updateOne(filter, update, options = {}) {
    const existing = this.docs.find((doc) => matches(doc, filter));
    if (!existing) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
      const inserted = { ...filter, ...(update.$set || {}), ...(update.$setOnInsert || {}) };
      for (const [field, amount] of Object.entries(update.$inc || {})) inserted[field] = (inserted[field] || 0) + amount;
      if (inserted._id === undefined) inserted._id = `${this.name}-${this.docs.length + 1}`;
      this.docs.push(inserted);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    Object.assign(existing, update.$set || {});
    for (const [field, amount] of Object.entries(update.$inc || {})) {
      existing[field] = (existing[field] || 0) + amount;
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async replaceOne(filter, doc, options = {}) {
    const index = this.docs.findIndex((candidate) => matches(candidate, filter));
    const stored = { ...doc };
    if (index >= 0) {
      this.docs[index] = stored;
      return { matchedCount: 1, modifiedCount: 1 };
    }
    if (options.upsert) {
      this.docs.push(stored);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async countDocuments(query = {}) {
    return this.docs.filter((doc) => matches(doc, query)).length;
  }

  listIndexes() {
    if (!this.registered) {
      const error = new Error(`ns not found: ${this.name}`);
      error.code = 26;
      error.codeName = "NamespaceNotFound";
      throw error;
    }
    return this.cursor(this.indexDefs.map((definition) => ({ ...definition })));
  }

  async createIndex(keys, options = {}) {
    const definition = { key: keys, name: options.name || keyTuple(keys) };
    if (options.expireAfterSeconds !== undefined) definition.expireAfterSeconds = options.expireAfterSeconds;
    this.indexDefs.push(definition);
    this.createdIndexes = this.createdIndexes || [];
    this.createdIndexes.push({ name: definition.name, keys, options });
    return definition.name;
  }
}

function removeIndex(collection, keys) {
  collection.indexDefs = collection.indexDefs.filter(
    (definition) => keyTuple(definition.key) !== keyTuple(keys),
  );
}

function createFakeDb({ registerAllIndexes = true, withTtl = true } = {}) {
  const collections = new Map();

  function getCollection(name) {
    if (!collections.has(name)) collections.set(name, new FakeCollection(name));
    return collections.get(name);
  }

  if (registerAllIndexes) {
    for (const [name, indexes] of Object.entries(REQUIRED_INDEXES)) {
      const collection = getCollection(name);
      collection.registered = true;
      for (const index of indexes) {
        const definition = { key: index.keys, name: index.options?.name || keyTuple(index.keys) };
        if (index.options?.expireAfterSeconds !== undefined) {
          definition.expireAfterSeconds = index.options.expireAfterSeconds;
        }
        collection.indexDefs.push(definition);
      }
    }
    if (withTtl) {
      for (const [name, ttl] of Object.entries(TTL_INDEXES)) {
        const collection = getCollection(name);
        collection.registered = true;
        const definition = { key: ttl.keys, name: ttl.options?.name || keyTuple(ttl.keys) };
        if (ttl.options?.expireAfterSeconds !== undefined) {
          definition.expireAfterSeconds = ttl.options.expireAfterSeconds;
        }
        collection.indexDefs.push(definition);
      }
    }
  }
  for (const name of ["side_effect_outbox", "material_search_reconciliation_audit", "material_search_tombstones"]) {
    getCollection(name).registered = true;
  }

  return {
    collections,
    collection: getCollection,
  };
}

function seedConsistentRestore(db) {
  db.collection(COLLECTIONS.materials).docs.push({
    _id: "mat-1",
    materialId: "mat-1",
    title: "Restored material",
    visibility: "public",
    price: 100,
    userAddress: "gcreator",
    searchVersion: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  db.collection("material_search_documents").docs.push({
    _id: "mat-1",
    materialId: "mat-1",
    projectionVersion: 1,
    title: "Restored material",
    projectedAt: new Date("2026-01-01T00:00:00Z"),
  });
  db.collection(COLLECTIONS.purchases).docs.push({
    _id: "purchase-1",
    purchaseId: "purchase-1",
    buyerAddress: "gbuyer",
    materialId: "mat-1",
    status: "settled",
    createdAt: new Date("2026-01-02T00:00:00Z"),
  });
  db.collection(COLLECTIONS.entitlementCache).docs.push({
    _id: "ent-1",
    buyerAddress: "gbuyer",
    materialId: "mat-1",
    active: true,
    state: "finalized",
  });
}

async function seedAuditChain(db, count = 3) {
  for (let index = 0; index < count; index += 1) {
    await appendAuditRecord({
      db,
      operationId: `op-${index}`,
      actor: "operator",
      action: "restore.test",
      target: { type: "system", id: "restore" },
      result: { index },
    });
  }
}

// ---------------------------------------------------------------------------
// Entitlement derived-view invariant
// ---------------------------------------------------------------------------

describe("restore invariants — entitlement derived view", () => {
  test("passes when cache reconciles with completed purchases", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    const report = await verifyEntitlementDerivedView(db);
    assert.equal(report.ok, true);
    assert.equal(report.sourceEntitlements, 1);
    assert.equal(report.cachedEntries, 1);
  });

  test("flags a completed purchase with no active entitlement (missing)", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    db.collection(COLLECTIONS.entitlementCache).docs = [];
    const report = await verifyEntitlementDerivedView(db);
    assert.equal(report.ok, false);
    assert.equal(report.missing, 1);
    assert.equal(report.violations[0].code, RESTORE_VIOLATION_CODES.ENTITLEMENT_MISSING);
    assert.equal(report.violations[0].buyerAddress, "gbuyer");
  });

  test("flags an active entitlement without a completed purchase (extra)", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    db.collection(COLLECTIONS.entitlementCache).docs.push({
      _id: "ent-stale",
      buyerAddress: "gstranger",
      materialId: "mat-1",
      active: true,
    });
    const report = await verifyEntitlementDerivedView(db);
    assert.equal(report.ok, false);
    assert.equal(report.extra, 1);
    assert.equal(report.violations[0].code, RESTORE_VIOLATION_CODES.ENTITLEMENT_EXTRA);
  });

  test("flags cache entries that contradict their purchase (mismatched)", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    db.collection(COLLECTIONS.entitlementCache).docs[0].active = false;
    const report = await verifyEntitlementDerivedView(db);
    assert.equal(report.ok, false);
    assert.equal(report.mismatched, 1);
    assert.equal(report.violations[0].code, RESTORE_VIOLATION_CODES.ENTITLEMENT_MISMATCHED);
  });
});

// ---------------------------------------------------------------------------
// Search projection invariant
// ---------------------------------------------------------------------------

describe("restore invariants — search projection", () => {
  test("passes when searchable materials are projected at the right version", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    const report = await verifySearchProjection(db);
    assert.equal(report.ok, true);
    assert.equal(report.scanned, 1);
    assert.equal(report.projectedOk, 1);
  });

  test("flags missing, stale, and unauthorized projections", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    db.collection(COLLECTIONS.materials).docs.push({
      _id: "mat-2",
      materialId: "mat-2",
      visibility: "public",
      searchVersion: 4,
      updatedAt: new Date(),
    });
    db.collection("material_search_documents").docs.push({
      _id: "mat-3",
      materialId: "mat-3",
      projectionVersion: 1,
    });
    db.collection(COLLECTIONS.materials).docs.push({
      _id: "mat-3",
      materialId: "mat-3",
      visibility: "private", // not searchable, but has a live projection
      searchVersion: 2,
      updatedAt: new Date(),
    });
    // Make mat-1's projection stale.
    db.collection("material_search_documents").docs[0].projectionVersion = 0;

    const report = await verifySearchProjection(db);
    assert.equal(report.ok, false);
    assert.equal(report.stale, 1);
    assert.equal(report.missing, 1);
    assert.equal(report.unauthorized, 1);
    assert.deepEqual(
      report.violations.map((violation) => violation.code).sort(),
      [
        RESTORE_VIOLATION_CODES.SEARCH_MISSING,
        RESTORE_VIOLATION_CODES.SEARCH_STALE,
        RESTORE_VIOLATION_CODES.SEARCH_UNAUTHORIZED,
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Index integrity invariant
// ---------------------------------------------------------------------------

describe("restore invariants — index integrity", () => {
  test("passes when every required index is present", async () => {
    const db = createFakeDb();
    const report = await verifyIndexes(db);
    assert.equal(report.ok, true);
    assert.ok(report.indexesRequired > 0);
  });

  test("flags a dropped required index with a scoped repair command", async () => {
    const db = createFakeDb();
    const materials = db.collection("materials");
    removeIndex(materials, { isDeleted: 1, visibility: 1, createdAt: -1 });

    const report = await verifyIndexes(db);
    assert.equal(report.ok, false);
    assert.ok(report.violations.some((violation) => violation.code === RESTORE_VIOLATION_CODES.INDEX_MISSING && violation.collection === "materials"));

    const steps = buildRepairSteps({ indexes: report });
    assert.equal(steps[0].code, "repair_indexes");
    assert.match(steps[0].command, /verify-restore\.mjs --repair=indexes/);
  });

  test("flags a missing TTL index on a present collection", async () => {
    const db = createFakeDb();
    removeIndex(db.collection("content_quarantine"), TTL_INDEXES.content_quarantine.keys);
    const report = await verifyIndexes(db);
    assert.ok(report.violations.some((violation) => violation.code === RESTORE_VIOLATION_CODES.TTL_INDEX_MISSING));
  });

  test("repairIndexes recreates only the missing indexes", async () => {
    const db = createFakeDb();
    const materials = db.collection("materials");
    removeIndex(materials, { txHash: 1 });
    const repair = await repairIndexes(db);
    assert.ok(repair.created.some((entry) => entry.collection === "materials"));
    assert.ok(materials.createdIndexes.some((entry) => keyTuple(entry.keys) === keyTuple({ txHash: 1 })));
    const recheck = await verifyIndexes(db);
    assert.equal(recheck.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Audit chain invariant
// ---------------------------------------------------------------------------

describe("restore invariants — audit chain", () => {
  test("verifies an intact hash chain", async () => {
    const db = createFakeDb();
    await seedAuditChain(db, 3);
    const report = await verifyAuditLedger(db);
    assert.equal(report.ok, true);
    assert.equal(report.records, 3);
  });

  test("fails loudly with the broken sequence when a record is tampered with", async () => {
    const db = createFakeDb();
    await seedAuditChain(db, 3);
    db.collection(COLLECTIONS.auditLedger).docs[1].result = { index: 999 }; // edit without re-hashing
    const report = await verifyAuditLedger(db);
    assert.equal(report.ok, false);
    assert.equal(report.brokenAtSequence, 1);
    assert.equal(report.violations[0].code, RESTORE_VIOLATION_CODES.AUDIT_CHAIN_BROKEN);
    assert.equal(buildRepairSteps({ audit: report })[0].code, "investigate_audit_chain");
  });
});

// ---------------------------------------------------------------------------
// Derived view rebuild + full orchestration
// ---------------------------------------------------------------------------

describe("restore invariants — rebuilds and orchestration", () => {
  test("rebuilding the entitlement cache converges verification after a restore gap", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    db.collection(COLLECTIONS.entitlementCache).docs = [];

    let report = await runRestoreVerification({ db });
    assert.equal(report.ok, false);
    assert.ok(report.repairSteps.some((step) => step.code === "repair_entitlement_cache"));

    const rebuild = await rebuildEntitlementCache(db);
    assert.equal(rebuild.rebuilt, 1);

    report = await runRestoreVerification({ db });
    assert.equal(report.ok, true);
    assert.deepEqual(report.repairSteps, []);
  });

  test("rebuilding search projections repairs missing derived rows", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    db.collection("material_search_documents").docs = [];

    let report = await verifySearchProjection(db);
    assert.equal(report.ok, false);

    const rebuild = await rebuildSearchProjections(db, { batchSize: 10 });
    assert.ok(rebuild.repaired >= 1);

    report = await verifySearchProjection(db);
    assert.equal(report.ok, true);
  });

  test("a fully consistent restore passes end-to-end with no repair steps", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    await seedAuditChain(db, 2);

    const report = await runRestoreVerification({ db });
    assert.equal(report.ok, true);
    assert.equal(report.violationCount, 0);
    assert.deepEqual(report.repairSteps, []);
    assert.ok(report.metrics);
  });

  test("mismatches fail loudly with per-code repair steps and no silent success", async () => {
    const db = createFakeDb();
    seedConsistentRestore(db);
    db.collection(COLLECTIONS.entitlementCache).docs = [];
    db.collection("material_search_documents").docs = [];
    removeIndex(db.collection("materials"), { txHash: 1 });

    const report = await runRestoreVerification({ db });
    assert.equal(report.ok, false);
    const codes = report.violations.map((violation) => violation.code);
    assert.ok(codes.includes(RESTORE_VIOLATION_CODES.ENTITLEMENT_MISSING));
    assert.ok(codes.includes(RESTORE_VIOLATION_CODES.SEARCH_MISSING));
    assert.ok(codes.includes(RESTORE_VIOLATION_CODES.INDEX_MISSING));
    const repairCodes = report.repairSteps.map((step) => step.code).sort();
    assert.deepEqual(repairCodes, ["repair_entitlement_cache", "repair_indexes", "repair_search_projection"]);
  });
});
