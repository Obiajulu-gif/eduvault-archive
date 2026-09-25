import assert from "node:assert/strict";
import test from "node:test";

import {
  MATERIAL_SEARCH_COLLECTION,
  MATERIAL_SEARCH_RECONCILIATION_COLLECTION,
  MATERIAL_SEARCH_TOMBSTONE_COLLECTION,
  applyMaterialSearchProjection,
  buildMaterialSearchIntent,
  buildMaterialSearchDocument,
  enqueueMaterialSearchProjection,
  evaluateMaterialSearchAccess,
  reconcileMaterialSearch,
} from "../../src/lib/backend/materialSearchProjection.js";

let nextId = 1;

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((clause) => matches(doc, clause));
    if (key === "$and") return expected.every((clause) => matches(doc, clause));
    const actual = doc[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if ("$gt" in expected && !(actual > expected.$gt)) return false;
      if ("$lte" in expected && !(actual <= expected.$lte)) return false;
      if ("$in" in expected && !expected.$in.includes(actual)) return false;
      return true;
    }
    return actual === expected;
  });
}

function sortDocs(docs, spec) {
  const [[key, direction]] = Object.entries(spec);
  return [...docs].sort((a, b) => {
    if (a[key] === b[key]) return 0;
    return a[key] > b[key] ? direction : -direction;
  });
}

class FakeCollection {
  constructor() {
    this.docs = new Map();
  }

  async insertOne(doc) {
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
    const doc = await this.findOne(query);
    if (!doc) return { deletedCount: 0 };
    this.docs.delete(doc._id);
    return { deletedCount: 1 };
  }

  async updateOne(query, update, options = {}) {
    const doc = await this.findOne(query);
    if (!doc && !options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    const target = doc || { _id: query._id ?? `fake-${nextId++}` };
    if (update.$set) Object.assign(target, update.$set);
    if (update.$setOnInsert && !doc) Object.assign(target, update.$setOnInsert);
    this.docs.set(target._id, target);
    return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0, upsertedCount: doc ? 0 : 1 };
  }

  async replaceOne(query, replacement, options = {}) {
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
      if (!collections.has(name)) collections.set(name, new FakeCollection());
      return collections.get(name);
    },
  };
}

async function withDb(fn) {
  await fn(createFakeDb());
}

function material(overrides = {}) {
  return {
    _id: "mat-1",
    title: "Searchable Algebra",
    description: "Linear equations and worked examples",
    shortSummary: "Algebra notes",
    author: "Ada",
    category: "math",
    subject: "algebra",
    visibility: "public",
    version: 1,
    searchVersion: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

test("search access policy excludes private, archived, suspended, deleted, and legal tombstone materials", () => {
  assert.equal(evaluateMaterialSearchAccess(material()).searchable, true);
  assert.equal(evaluateMaterialSearchAccess(material({ visibility: "private" })).reason, "not_public");
  assert.equal(evaluateMaterialSearchAccess(material({ archived: true })).reason, "archived");
  assert.equal(evaluateMaterialSearchAccess(material({ creatorSuspended: true })).reason, "creator_suspended");
  assert.equal(evaluateMaterialSearchAccess(material({ isDeleted: true })).reason, "soft_deleted");
  assert.deepEqual(
    evaluateMaterialSearchAccess(material({ legalTombstone: true })),
    { searchable: false, reason: "legal_tombstone", permanent: true },
  );
});

test("projection stores only search-safe fields for public materials", () => {
  const doc = buildMaterialSearchDocument(material({ storageKey: "secret.pdf", fileUrl: "https://files.example/secret" }));

  assert.equal(doc._id, "mat-1");
  assert.equal(doc.title, "Searchable Algebra");
  assert.equal(doc.storageKey, undefined);
  assert.equal(doc.fileUrl, undefined);
  assert.equal(doc.projectionVersion, 1);
});

test("out-of-order and duplicate updates cannot resurrect tombstoned data", async () => {
  await withDb(async (db) => {
    await applyMaterialSearchProjection(db, buildMaterialSearchIntent(material({ searchVersion: 1 })).payload);
    await applyMaterialSearchProjection(db, buildMaterialSearchIntent(material({ searchVersion: 2, archived: true })).payload);
    await applyMaterialSearchProjection(db, buildMaterialSearchIntent(material({ searchVersion: 1 })).payload);
    await applyMaterialSearchProjection(db, buildMaterialSearchIntent(material({ searchVersion: 2 })).payload);

    const projected = await db.collection(MATERIAL_SEARCH_COLLECTION).findOne({ _id: "mat-1" });
    const tombstone = await db.collection(MATERIAL_SEARCH_TOMBSTONE_COLLECTION).findOne({ _id: "mat-1" });

    assert.equal(projected, null);
    assert.equal(tombstone.version, 2);
  });
});

test("newer non-legal state can republish after archive restore", async () => {
  await withDb(async (db) => {
    await applyMaterialSearchProjection(db, buildMaterialSearchIntent(material({ searchVersion: 2, archived: true })).payload);
    const result = await applyMaterialSearchProjection(db, buildMaterialSearchIntent(material({ searchVersion: 3, archived: false })).payload);

    const projected = await db.collection(MATERIAL_SEARCH_COLLECTION).findOne({ _id: "mat-1" });
    assert.equal(result.action, "inserted");
    assert.equal(projected.projectionVersion, 3);
  });
});

test("legal tombstones block later projection attempts", async () => {
  await withDb(async (db) => {
    await applyMaterialSearchProjection(db, buildMaterialSearchIntent(material({ searchVersion: 4, legalTombstone: true })).payload);
    const result = await applyMaterialSearchProjection(db, buildMaterialSearchIntent(material({ searchVersion: 5 })).payload);

    assert.equal(result.action, "ignored");
    assert.equal(await db.collection(MATERIAL_SEARCH_COLLECTION).findOne({ _id: "mat-1" }), null);
  });
});

test("enqueueMaterialSearchProjection writes versioned outbox intent", async () => {
  await withDb(async (db) => {
    await enqueueMaterialSearchProjection({
      db,
      material: material({ searchVersion: 7 }),
      reason: "material_updated",
      enqueue: (entry) => db.collection("side_effect_outbox").insertOne(entry).then(({ insertedId }) => ({ ...entry, _id: insertedId })),
    });

    const outbox = await db.collection("side_effect_outbox").findOne({ sourceId: "mat-1" });
    assert.equal(outbox.intent.action, "material_search_sync");
    assert.equal(outbox.intent.payload.version, 7);
    assert.match(outbox.deliveryId, /^material-search:mat-1:7:material_updated$/);
  });
});

test("reconciliation detects and repairs missing, stale, and unauthorized documents with audit diff", async () => {
  await withDb(async (db) => {
    await db.collection("materials").insertMany([
      material({ _id: "mat-1", searchVersion: 3 }),
      material({ _id: "mat-2", searchVersion: 5, title: "Geometry" }),
      material({ _id: "mat-3", searchVersion: 2, archived: true }),
    ]);
    await db.collection(MATERIAL_SEARCH_COLLECTION).insertMany([
      { ...buildMaterialSearchDocument(material({ _id: "mat-2", searchVersion: 1 })), projectionVersion: 1 },
      { ...buildMaterialSearchDocument(material({ _id: "mat-3", searchVersion: 1 })), projectionVersion: 1 },
    ]);

    const result = await reconcileMaterialSearch({ db, batchSize: 2, repair: true, runId: "run-1" });

    assert.equal(result.diff.length, 2);
    assert.deepEqual(result.diff.map((item) => item.type), ["missing", "stale"]);
    assert.equal(result.nextCursor, "mat-2");

    const second = await reconcileMaterialSearch({ db, cursor: result.nextCursor, batchSize: 2, repair: true, runId: "run-1" });
    assert.equal(second.diff.length, 1);
    assert.equal(second.diff[0].type, "unauthorized");

    const repaired = await db.collection(MATERIAL_SEARCH_COLLECTION).findOne({ _id: "mat-1" });
    const staleRepaired = await db.collection(MATERIAL_SEARCH_COLLECTION).findOne({ _id: "mat-2" });
    const unauthorizedRemoved = await db.collection(MATERIAL_SEARCH_COLLECTION).findOne({ _id: "mat-3" });
    const audits = await db.collection(MATERIAL_SEARCH_RECONCILIATION_COLLECTION).find({ runId: "run-1" }).toArray();

    assert.equal(repaired.projectionVersion, 3);
    assert.equal(staleRepaired.projectionVersion, 5);
    assert.equal(unauthorizedRemoved, null);
    assert.equal(audits.length, 2);
  });
});
