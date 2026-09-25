/**
 * Tests for EduVault backup restore verification procedure — Issue #715
 *
 * Covers secret key validation, protected material file hash integrity,
 * entitlement decision verification, and restore drill orchestration.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  validateSecrets,
  validateProtectedMaterialHashes,
  validateEntitlementDecisions,
  verifyEntitlementLogic,
  runRestoreVerification,
} from "../../scripts/restore-verification.mjs";

// ── In-Memory MongoDB Collection Mock ──────────────────────────────────────────

function createMockCollection() {
  const docs = new Map();

  return {
    docs,
    async findOne(query) {
      for (const doc of docs.values()) {
        const matches = Object.entries(query).every(([key, val]) => {
          if (val && typeof val === "object" && "$in" in val) {
            return val.$in.includes(doc[key]);
          }
          return String(doc[key]) === String(val);
        });
        if (matches) return doc;
      }
      return null;
    },

    find(query = {}) {
      const results = [];
      for (const doc of docs.values()) {
        let matches = true;

        if (query.$or && Array.isArray(query.$or)) {
          matches = query.$or.some((subQuery) => {
            return Object.entries(subQuery).every(([key, val]) => {
              if (val && typeof val === "object") {
                if ("$gt" in val) return (doc[key] ?? 0) > val.$gt;
                if ("$exists" in val) {
                  const exists = key in doc;
                  const notEqual = "$ne" in val ? doc[key] !== val.$ne : true;
                  return val.$exists ? exists && notEqual : !exists;
                }
              }
              return String(doc[key]) === String(val);
            });
          });
        } else {
          matches = Object.entries(query).every(([key, val]) => {
            if (val && typeof val === "object" && "$in" in val) {
              return val.$in.includes(doc[key]);
            }
            return String(doc[key]) === String(val);
          });
        }

        if (matches) results.push(doc);
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
  };
}

function createMockDb(collections = {}) {
  const colls = {
    materials: createMockCollection(),
    users: createMockCollection(),
    purchases: createMockCollection(),
    entitlement_cache: createMockCollection(),
    sync_state: createMockCollection(),
    sync_events: createMockCollection(),
    dead_letter_events: createMockCollection(),
    material_history: createMockCollection(),
    saved_materials: createMockCollection(),
    ...collections,
  };

  return {
    collection: (name) => colls[name] ?? createMockCollection(),
  };
}

function createMockMongoClient(db) {
  return {
    db: () => db,
  };
}

// ── Test Constants ────────────────────────────────────────────────────────────

const VALID_JWT_SECRET = "super_secret_jwt_key_that_is_at_least_32_bytes_long_123456789";

// ── Secret Validation Tests ───────────────────────────────────────────────────

describe("Restore Verification — Secret & Key Handling (#715)", () => {
  test("passes when valid JWT_SECRET and MONGODB_URI are present", () => {
    const env = {
      JWT_SECRET: VALID_JWT_SECRET,
      MONGODB_URI: "mongodb://localhost:27017/eduvault",
    };
    const result = validateSecrets(env);
    assert.equal(result.ok, true);
    assert.equal(result.violations.length, 0);
  });

  test("fails when JWT_SECRET is missing", () => {
    const env = {
      MONGODB_URI: "mongodb://localhost:27017/eduvault",
    };
    const result = validateSecrets(env);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.secret === "JWT_SECRET"));
  });

  test("fails when JWT_SECRET is too short (< 32 chars)", () => {
    const env = {
      JWT_SECRET: "too_short_secret",
      MONGODB_URI: "mongodb://localhost:27017/eduvault",
    };
    const result = validateSecrets(env);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.secret === "JWT_SECRET" && v.reason.includes("32 characters")));
  });

  test("fails when MONGODB_URI is missing", () => {
    const env = {
      JWT_SECRET: VALID_JWT_SECRET,
    };
    const result = validateSecrets(env);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.secret === "MONGODB_URI"));
  });
});

// ── Content Hash Integrity Tests ──────────────────────────────────────────────

describe("Restore Verification — Content Hashes & File References (#715)", () => {
  test("passes when protected materials have valid storage keys and hashes", async () => {
    const db = createMockDb();
    const materials = db.collection("materials");

    materials.docs.set("mat-001", {
      _id: "mat-001",
      title: "Protected Course 1",
      price: 500,
      visibility: "public",
      storageKey: "QmValidStorageKey1234567890",
      fileHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });

    materials.docs.set("mat-002", {
      _id: "mat-002",
      title: "Private Research Paper",
      price: 0,
      visibility: "private",
      ipfsCid: "bafybeicg2568735238753287523",
    });

    const report = await validateProtectedMaterialHashes(db);
    assert.equal(report.violations, 0);
    assert.equal(report.totalProtected, 2);
  });

  test("detects missing storage key / CID on protected material", async () => {
    const db = createMockDb();
    const materials = db.collection("materials");

    materials.docs.set("mat-missing-cid", {
      _id: "mat-missing-cid",
      title: "Broken Paid Book",
      price: 1500,
      visibility: "public",
      storageKey: null,
      ipfsCid: null,
      cid: null,
    });

    const report = await validateProtectedMaterialHashes(db);
    assert.equal(report.violations, 1);
    assert.ok(report.violationSamples[0].reasons[0].includes("missing file/CID reference"));
  });

  test("detects corrupted/short fileHash on protected material", async () => {
    const db = createMockDb();
    const materials = db.collection("materials");

    materials.docs.set("mat-bad-hash", {
      _id: "mat-bad-hash",
      title: "Corrupted Hash Material",
      price: 200,
      visibility: "public",
      storageKey: "QmValidKey123",
      fileHash: "bad", // Too short
    });

    const report = await validateProtectedMaterialHashes(db);
    assert.equal(report.violations, 1);
    assert.ok(report.violationSamples[0].reasons[0].includes("short or corrupted"));
  });
});

// ── Entitlement Decision Integrity Tests ──────────────────────────────────────

describe("Restore Verification — Entitlement Decision Integrity (#715)", () => {
  test("passes when entitled buyers have access and unentitled callers are denied", async () => {
    const db = createMockDb();
    const materials = db.collection("materials");
    const purchases = db.collection("purchases");
    const cache = db.collection("entitlement_cache");

    const matId = "mat-entitled-001";
    const buyer = "GBUYER1234567890";

    materials.docs.set(matId, {
      _id: matId,
      title: "Restored Material",
      price: 1000,
      visibility: "private",
      storageKey: "QmRestored123",
    });

    purchases.docs.set(`${matId}:${buyer.toLowerCase()}`, {
      _id: "p1",
      materialId: matId,
      buyerAddress: buyer.toLowerCase(),
      status: "settled",
    });

    cache.docs.set(`${matId}:${buyer.toLowerCase()}`, {
      _id: "c1",
      materialId: matId,
      buyerAddress: buyer.toLowerCase(),
      active: true,
    });

    const report = await validateEntitlementDecisions(db);
    assert.equal(report.violations, 0);
    assert.ok(report.entitledChecks > 0);
    assert.ok(report.unentitledChecks > 0);
  });

  test("detects access denial for buyer with active entitlement cache", async () => {
    const db = createMockDb();
    const cache = db.collection("entitlement_cache");
    const matId = "mat-denied-001";
    const buyer = "GBUYERDENIED";

    cache.docs.set(`${matId}:${buyer.toLowerCase()}`, {
      _id: "c1",
      materialId: matId,
      buyerAddress: buyer.toLowerCase(),
      active: false, // Active set to false, but purchase missing
    });

    // Directly test verifyEntitlementLogic
    const decision = await verifyEntitlementLogic(db, matId, buyer);
    assert.equal(decision.hasAccess, false);
  });

  test("detects access leak when unentitled buyer gets access", async () => {
    const db = createMockDb();
    const materials = db.collection("materials");
    const cache = db.collection("entitlement_cache");
    const matId = "mat-leak-001";
    const unentitled = "unentitled_verifier_probe_addr_0x9999";

    materials.docs.set(matId, {
      _id: matId,
      price: 500,
      visibility: "private",
    });

    // Erroneously active cache doc for unentitled caller
    cache.docs.set(`${matId}:${unentitled}`, {
      _id: "c-err",
      materialId: matId,
      buyerAddress: unentitled,
      active: true,
    });

    const report = await validateEntitlementDecisions(db);
    assert.equal(report.violations, 1);
    assert.equal(report.violationSamples[0].type, "unentitled_access_leak");
  });

  test("detects access leak for refunded/revoked purchases", async () => {
    const db = createMockDb();
    const purchases = db.collection("purchases");
    const matId = "mat-refunded-001";
    const buyer = "GBUYERREFUNDED";

    // Purchase marked settled in purchases, but in testing verify logic with revoked:
    purchases.docs.set(`${matId}:${buyer.toLowerCase()}`, {
      _id: "p-ref",
      materialId: matId,
      buyerAddress: buyer.toLowerCase(),
      status: "refunded", // Refunded purchase
    });

    const decision = await verifyEntitlementLogic(db, matId, buyer);
    assert.equal(decision.hasAccess, false);
  });
});

// ── Full Orchestration Tests ──────────────────────────────────────────────────

describe("Restore Verification — Full Runner Orchestration (#715)", () => {
  test("runRestoreVerification returns ok=true on valid clean database", async () => {
    const db = createMockDb();

    // Populate required collection schemas
    db.collection("materials").docs.set("m1", {
      _id: "m1",
      title: "Clean Material",
      userAddress: "GCREATOR",
      visibility: "public",
      createdAt: new Date().toISOString(),
    });
    db.collection("users").docs.set("u1", { _id: "u1", walletAddress: "GUSER" });
    db.collection("purchases").docs.set("p1", { _id: "p1", buyerAddress: "gbuyer", materialId: "m1", createdAt: new Date().toISOString() });
    db.collection("entitlement_cache").docs.set("c1", { _id: "c1", buyerAddress: "gbuyer", materialId: "m1", active: true });
    db.collection("sync_state").docs.set("s1", { _id: "s1", source: "stellar" });
    db.collection("sync_events").docs.set("e1", { _id: "e1" });
    db.collection("dead_letter_events").docs.set("d1", { _id: "d1", status: "pending" });
    db.collection("material_history").docs.set("h1", { _id: "h1", materialId: "m1" });
    db.collection("saved_materials").docs.set("sm1", { _id: "sm1", walletAddress: "guser", materialId: "m1" });

    const mongoClient = createMockMongoClient(db);
    const env = {
      JWT_SECRET: VALID_JWT_SECRET,
      MONGODB_URI: "mongodb://localhost:27017/eduvault",
    };

    const result = await runRestoreVerification({ mongoClient, dbName: "eduvault", env });
    assert.equal(result.ok, true);
    assert.equal(result.summary.totalViolations, 0);
  });

  test("runRestoreVerification returns ok=false when secret validation fails", async () => {
    const db = createMockDb();
    const mongoClient = createMockMongoClient(db);
    const env = {
      JWT_SECRET: "short", // Invalid secret
      MONGODB_URI: "mongodb://localhost:27017/eduvault",
    };

    const result = await runRestoreVerification({ mongoClient, dbName: "eduvault", env });
    assert.equal(result.ok, false);
    assert.ok(result.summary.totalViolations > 0);
  });
});
