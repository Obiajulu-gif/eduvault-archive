/**
 * Tests for manual repair command with dry-run and audit output — Issue #886
 *
 * Covers dry-run, apply, no-op, invalid target, and audit record output.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  findInconsistencies,
  repairMaterial,
  writeAuditRecord,
  runRepair,
} from "../../scripts/repair-materials.mjs";

function createMockCollection() {
  const docs = new Map();
  return {
    docs,
    async findOne(query) {
      for (const doc of docs.values()) {
        const matches = Object.entries(query).every(([key, val]) => {
          return String(doc[key]) === String(val);
        });
        if (matches) return doc;
      }
      return null;
    },
    find(query = {}) {
      const results = [];
      for (const doc of docs.values()) {
        results.push(doc);
      }
      return {
        async *[Symbol.asyncIterator]() {
          for (const doc of results) {
            yield doc;
          }
        },
        async close() {},
      };
    },
    async updateOne(query, update) {
      for (const [key, doc] of docs) {
        if (String(doc._id) === String(query._id)) {
          Object.assign(doc, update.$set || {});
          return { modifiedCount: 1 };
        }
      }
      return { modifiedCount: 0 };
    },
    async insertOne(doc) {
      const id = `audit-${Date.now()}`;
      docs.set(id, { ...doc, _id: id });
      return { insertedId: id };
    },
  };
}

function createMockDb(collections = {}) {
  const colls = {
    materials: createMockCollection(),
    repair_audit_log: createMockCollection(),
    ...collections,
  };
  return {
    collection: (name) => colls[name] ?? createMockCollection(),
  };
}

function createMockMongoClient(db) {
  return { db: () => db };
}

describe("Repair Materials — Dry-Run (#886)", () => {
  test("dry-run performs no writes", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test",
      fileUrl: "https://example.com/file.pdf",
      storageKey: null,
      visibility: "public",
      price: 100,
    });
    const result = await repairMaterial(db, "m1", { dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.repaired, false);
    assert.equal(result.dryRun, true);
    assert.ok(result.fixes.length > 0);
  });

  test("dry-run reports intended changes", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test",
      fileUrl: "https://example.com/file.pdf",
      storageKey: null,
      visibility: "public",
      price: 100,
    });
    const result = await repairMaterial(db, "m1", { dryRun: true });
    const storageKeyFix = result.fixes.find((f) => f.field === "storageKey");
    assert.ok(storageKeyFix);
    assert.equal(storageKeyFix.newValue, "https://example.com/file.pdf");
  });
});

describe("Repair Materials — Apply (#886)", () => {
  test("apply mode repairs targeted records", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test",
      fileUrl: "https://example.com/file.pdf",
      storageKey: null,
      visibility: "public",
      price: 100,
    });
    const result = await repairMaterial(db, "m1", { dryRun: false });
    assert.equal(result.ok, true);
    assert.equal(result.repaired, true);
    const doc = db.collection("materials").docs.get("m1");
    assert.equal(doc.storageKey, "https://example.com/file.pdf");
  });

  test("apply mode repairs only the targeted material", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test 1",
      fileUrl: "https://example.com/1.pdf",
      storageKey: null,
      visibility: "public",
      price: 100,
    });
    db.collection("materials").docs.set("m2", {
      _id: "m2",
      title: "Test 2",
      fileUrl: "https://example.com/2.pdf",
      storageKey: null,
      visibility: "public",
      price: 200,
    });
    await repairMaterial(db, "m1", { dryRun: false });
    const doc2 = db.collection("materials").docs.get("m2");
    assert.equal(doc2.storageKey, null);
  });
});

describe("Repair Materials — No-Op (#886)", () => {
  test("no-op when no inconsistencies found", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Clean",
      storageKey: "QmValid",
      visibility: "public",
      price: 100,
    });
    const result = await repairMaterial(db, "m1", { dryRun: false });
    assert.equal(result.ok, true);
    assert.equal(result.repaired, false);
    assert.equal(result.fixes.length, 0);
  });
});

describe("Repair Materials — Invalid Target (#886)", () => {
  test("invalid target returns error", async () => {
    const db = createMockDb();
    const result = await repairMaterial(db, "nonexistent", { dryRun: false });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("not found"));
  });
});

describe("Repair Materials — Audit Record (#886)", () => {
  test("audit record is written on apply", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test",
      fileUrl: "https://example.com/file.pdf",
      storageKey: null,
      visibility: "public",
      price: 100,
    });
    const result = await repairMaterial(db, "m1", { dryRun: false });
    assert.equal(result.ok, true);
    assert.ok(result.auditRecordId);
    const auditDoc = db.collection("repair_audit_log").docs.get(result.auditRecordId);
    assert.ok(auditDoc);
    assert.equal(auditDoc.materialId, "m1");
    assert.equal(auditDoc.action, "repair");
  });

  test("writeAuditRecord writes to audit collection", async () => {
    const db = createMockDb();
    const result = await writeAuditRecord(db, {
      materialId: "m1",
      action: "repair",
      fixes: [{ field: "storageKey", oldValue: null, newValue: "new" }],
    });
    assert.equal(result.ok, true);
    assert.ok(result.auditId);
  });
});

describe("Repair Materials — Inconsistency Detection (#886)", () => {
  test("detects missing storageKey with fileUrl", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test",
      fileUrl: "https://example.com/file.pdf",
      storageKey: null,
      visibility: "public",
      price: 100,
    });
    const results = await findInconsistencies(db);
    assert.equal(results.length, 1);
    assert.equal(results[0].materialId, "m1");
    assert.ok(results[0].issues.some((i) => i.type === "missing-storage-key"));
  });

  test("detects private material without price", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test",
      storageKey: "QmValid",
      visibility: "private",
      price: 0,
    });
    const results = await findInconsistencies(db);
    assert.equal(results.length, 1);
    assert.ok(results[0].issues.some((i) => i.type === "private-without-price"));
  });

  test("detects deleted material with search version", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test",
      storageKey: "QmValid",
      visibility: "public",
      price: 100,
      isDeleted: true,
      searchVersion: 5,
    });
    const results = await findInconsistencies(db);
    assert.equal(results.length, 1);
    assert.ok(results[0].issues.some((i) => i.type === "deleted-with-search-version"));
  });

  test("clean material has no inconsistencies", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Clean",
      storageKey: "QmValid",
      visibility: "public",
      price: 100,
      isDeleted: false,
      searchVersion: 0,
    });
    const results = await findInconsistencies(db);
    assert.equal(results.length, 0);
  });
});

describe("Repair Materials — Full Runner (#886)", () => {
  test("runRepair with targetId repairs specific material", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test",
      fileUrl: "https://example.com/file.pdf",
      storageKey: null,
      visibility: "public",
      price: 100,
    });
    const client = createMockMongoClient(db);
    const result = await runRepair({ mongoClient: client, targetId: "m1", dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
  });

  test("runRepair without targetId repairs all", async () => {
    const db = createMockDb();
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Test 1",
      fileUrl: "https://example.com/1.pdf",
      storageKey: null,
      visibility: "public",
      price: 100,
    });
    db.collection("materials").docs.set("m2", {
      _id: "m2",
      title: "Test 2",
      fileUrl: "https://example.com/2.pdf",
      storageKey: null,
      visibility: "public",
      price: 200,
    });
    const client = createMockMongoClient(db);
    const result = await runRepair({ mongoClient: client, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.totalFound, 2);
  });
});
