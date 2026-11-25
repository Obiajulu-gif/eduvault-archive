import assert from "node:assert/strict";
import test from "node:test";

import {
  MATERIAL_SEARCH_COLLECTION,
  MATERIAL_SEARCH_TOMBSTONE_COLLECTION,
  buildMaterialSearchDocument,
} from "../../src/lib/backend/materialSearchProjection.js";
import {
  MATERIAL_SEARCH_REPAIR_AUDIT_COLLECTION,
  MATERIAL_SEARCH_REPAIR_FAILURES_COLLECTION,
  REPAIR_ACTIONS,
  repairSearchIndex,
  rollbackSearchIndexRepair,
  scanSearchIndexInconsistencies,
  validateRepairAuthorization,
} from "../../src/lib/backend/searchIndexRepair.js";

let nextId = 1;

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((clause) => matches(doc, clause));
    if (key === "$and") return expected.every((clause) => matches(doc, clause));
    const actual = doc[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("$gt" in expected && !(actual > expected.$gt)) return false;
      if ("$lt" in expected && !(actual < expected.$lt)) return false;
      if ("$lte" in expected && !(actual <= expected.$lte)) return false;
      if ("$ne" in expected && actual === expected.$ne) return false;
      if ("$in" in expected && !expected.$in.includes(actual)) return false;
      return true;
    }
    return actual === expected;
  });
}

function sortDocs(docs, spec) {
  const entries = Object.entries(spec);
  if (!entries.length) return docs;
  const [[key, direction]] = entries;
  return [...docs].sort((a, b) => {
    if (a[key] === b[key]) return 0;
    return a[key] > b[key] ? direction : -direction;
  });
}

class FakeCollection {
  constructor(name = "") {
    this.name = name;
    this.docs = new Map();
    this.failNext = null;
  }

  async insertOne(doc) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const _id = doc._id ?? `fake-${nextId++}`;
    this.docs.set(_id, { ...doc, _id });
    return { insertedId: _id };
  }

  async insertMany(docs) {
    for (const doc of docs) await this.insertOne(doc);
  }

  async findOne(query) {
    return [...this.docs.values()].find((doc) => matches(doc, query)) || null;
  }

  async deleteOne(query) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const doc = await this.findOne(query);
    if (!doc) return { deletedCount: 0 };
    this.docs.delete(doc._id);
    return { deletedCount: 1 };
  }

  async updateOne(query, update, options = {}) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const doc = await this.findOne(query);
    if (!doc && !options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    const target = doc ? { ...doc } : { _id: query._id ?? `fake-${nextId++}` };
    if (update.$set) Object.assign(target, update.$set);
    if (update.$setOnInsert && !doc) Object.assign(target, update.$setOnInsert);
    this.docs.set(target._id, target);
    return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0, upsertedCount: doc ? 0 : 1 };
  }

  async replaceOne(query, replacement, options = {}) {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const doc = await this.findOne(query);
    if (!doc && !options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    this.docs.set(replacement._id, { ...replacement });
    return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0, upsertedCount: doc ? 0 : 1 };
  }

  find(query = {}) {
    const matched = [...this.docs.values()].filter((doc) => matches(doc, query));
    let sorted = matched;
    return {
      sort(spec) {
        sorted = sortDocs(sorted, spec);
        return this;
      },
      limit(count) {
        sorted = sorted.slice(0, count);
        return this;
      },
      async toArray() {
        return sorted;
      },
    };
  }
}

function createFakeDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new FakeCollection(name));
      return collections.get(name);
    },
  };
}

function baseMaterial(overrides = {}) {
  return {
    _id: "mat-1",
    title: "Test Material",
    description: "Educational notes",
    author: "Tutor",
    category: "science",
    subject: "physics",
    visibility: "public",
    archived: false,
    isDeleted: false,
    version: 1,
    searchVersion: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

test("authorization: rejects unauthorized actors and accepts privileged operators", () => {
  assert.throws(
    () => validateRepairAuthorization(null),
    (err) => err.code === "AUTH_UNAUTHENTICATED"
  );

  assert.throws(
    () => validateRepairAuthorization({ role: "buyer" }),
    (err) => err.code === "AUTH_FORBIDDEN"
  );

  assert.equal(validateRepairAuthorization({ isCli: true }), true);
  assert.equal(validateRepairAuthorization({ role: "admin" }), true);
  assert.equal(validateRepairAuthorization({ role: "deployer" }), true);
  assert.equal(validateRepairAuthorization({ permissions: ["system:repair"] }), true);
});

test("scanning: detects archived, permission-changed, orphan, stale, and missing materials", async () => {
  const db = createFakeDb();
  const materials = db.collection("materials");
  const search = db.collection(MATERIAL_SEARCH_COLLECTION);

  // 1. Unauthorized: archived material leaked into search
  const matArchived = baseMaterial({ _id: "mat-archived", archived: true, searchVersion: 2 });
  await materials.insertOne(matArchived);
  await search.insertOne(buildMaterialSearchDocument(baseMaterial({ _id: "mat-archived", searchVersion: 1 })));

  // 2. Unauthorized: visibility changed from public to private
  const matPrivate = baseMaterial({ _id: "mat-private", visibility: "private", searchVersion: 2 });
  await materials.insertOne(matPrivate);
  await search.insertOne(buildMaterialSearchDocument(baseMaterial({ _id: "mat-private", searchVersion: 1 })));

  // 3. Orphan: search doc exists without source material
  await search.insertOne({ _id: "mat-orphan", materialId: "mat-orphan", title: "Orphan", visibility: "public" });

  // 4. Stale: material was updated to searchVersion 3, but search doc is at version 1
  const matStale = baseMaterial({ _id: "mat-stale", searchVersion: 3 });
  await materials.insertOne(matStale);
  await search.insertOne(buildMaterialSearchDocument(baseMaterial({ _id: "mat-stale", searchVersion: 1 })));

  // 5. Missing: public material without search document
  const matMissing = baseMaterial({ _id: "mat-missing", searchVersion: 1 });
  await materials.insertOne(matMissing);

  const inconsistencies = await scanSearchIndexInconsistencies(db);
  assert.equal(inconsistencies.length, 5);

  const byAction = Object.fromEntries(inconsistencies.map((i) => [i.materialId, i.action]));
  assert.equal(byAction["mat-archived"], REPAIR_ACTIONS.REMOVE_UNAUTHORIZED);
  assert.equal(byAction["mat-private"], REPAIR_ACTIONS.REMOVE_UNAUTHORIZED);
  assert.equal(byAction["mat-orphan"], REPAIR_ACTIONS.REMOVE_ORPHAN);
  assert.equal(byAction["mat-stale"], REPAIR_ACTIONS.REFRESH_STALE);
  assert.equal(byAction["mat-missing"], REPAIR_ACTIONS.INDEX_MISSING);
});

test("repair execution: dry-run reports planned changes without writing", async () => {
  const db = createFakeDb();
  const materials = db.collection("materials");
  const search = db.collection(MATERIAL_SEARCH_COLLECTION);

  const matArchived = baseMaterial({ _id: "mat-archived", archived: true });
  await materials.insertOne(matArchived);
  await search.insertOne(buildMaterialSearchDocument(baseMaterial({ _id: "mat-archived" })));

  const summary = await repairSearchIndex(db, { dryRun: true });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.unauthorized, 1);
  assert.equal(summary.repaired, 0);

  // Document must still be present in search collection (no write in dry-run)
  const stillInSearch = await search.findOne({ _id: "mat-archived" });
  assert.ok(stillInSearch);
});

test("repair execution: apply removes unauthorized/archived materials and tombstones them", async () => {
  const db = createFakeDb();
  const materials = db.collection("materials");
  const search = db.collection(MATERIAL_SEARCH_COLLECTION);
  const tombstones = db.collection(MATERIAL_SEARCH_TOMBSTONE_COLLECTION);
  const audit = db.collection(MATERIAL_SEARCH_REPAIR_AUDIT_COLLECTION);

  const matArchived = baseMaterial({ _id: "mat-archived", archived: true });
  await materials.insertOne(matArchived);
  await search.insertOne(buildMaterialSearchDocument(baseMaterial({ _id: "mat-archived" })));

  const matMissing = baseMaterial({ _id: "mat-missing" });
  await materials.insertOne(matMissing);

  const summary = await repairSearchIndex(db, { dryRun: false });
  assert.equal(summary.dryRun, false);
  assert.equal(summary.repaired, 2);
  assert.equal(summary.removed, 1);
  assert.equal(summary.missing, 1);

  // Unauthorized material must be deleted from search index
  const removedSearchDoc = await search.findOne({ _id: "mat-archived" });
  assert.equal(removedSearchDoc, null);

  // Tombstone must be written
  const tombstone = await tombstones.findOne({ _id: "mat-archived" });
  assert.ok(tombstone);
  assert.equal(tombstone.reason, "archived");

  // Missing material must now be indexed
  const indexedSearchDoc = await search.findOne({ _id: "mat-missing" });
  assert.ok(indexedSearchDoc);
  assert.equal(indexedSearchDoc.materialId, "mat-missing");

  // Audit record must be persisted
  const auditDoc = await audit.findOne({ runId: summary.runId });
  assert.ok(auditDoc);
  assert.equal(auditDoc.repaired, 2);
});

test("error handling and retry: isolated failures do not crash entire repair batch", async () => {
  const db = createFakeDb();
  const materials = db.collection("materials");
  const search = db.collection(MATERIAL_SEARCH_COLLECTION);
  const failures = db.collection(MATERIAL_SEARCH_REPAIR_FAILURES_COLLECTION);

  const matGood = baseMaterial({ _id: "mat-good" });
  await materials.insertOne(matGood);

  // Simulate persistent failure on search.replaceOne
  search.failNext = new Error("Simulated storage write error");

  const summary = await repairSearchIndex(db, { dryRun: false, maxRetries: 1 });
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].materialId, "mat-good");

  const failureDoc = await failures.findOne({ materialId: "mat-good" });
  assert.ok(failureDoc);
  assert.ok(failureDoc.errorMessage.includes("Simulated storage write error"));
});

test("rollback: restores search documents from pre-repair audit snapshot", async () => {
  const db = createFakeDb();
  const materials = db.collection("materials");
  const search = db.collection(MATERIAL_SEARCH_COLLECTION);

  // Material is archived, so repair will delete it
  const matArchived = baseMaterial({ _id: "mat-1", archived: true });
  await materials.insertOne(matArchived);
  const originalDoc = buildMaterialSearchDocument(baseMaterial({ _id: "mat-1" }));
  await search.insertOne(originalDoc);

  // Apply repair
  const repairSummary = await repairSearchIndex(db, { dryRun: false });
  assert.equal(await search.findOne({ _id: "mat-1" }), null);

  // Rollback repair
  const rollbackResult = await rollbackSearchIndexRepair(db, { runId: repairSummary.runId });
  assert.equal(rollbackResult.ok, true);
  assert.equal(rollbackResult.rolledBackCount, 1);

  // Document should be restored
  const restoredDoc = await search.findOne({ _id: "mat-1" });
  assert.ok(restoredDoc);
  assert.equal(restoredDoc.materialId, "mat-1");

  // Re-rolling back same runId must conflict
  await assert.rejects(
    () => rollbackSearchIndexRepair(db, { runId: repairSummary.runId }),
    (err) => err.code === "CONFLICT"
  );
});
