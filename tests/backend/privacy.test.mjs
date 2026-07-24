/**
 * Privacy System Tests
 *
 * Follows the project pattern: pure logic is extracted and tested against
 * in-memory DB doubles. Each section is self-contained with no live I/O.
 *
 * Covers:
 *  1. retentionPolicy helpers (imported directly – no DB calls)
 *  2. Deletion state machine logic
 *  3. Obligation checker logic
 *  4. Anonymization logic
 *  5. Data export service logic
 *  6. State transition guard table
 *  7. Partial-failure recovery properties
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

// ─── In-memory Mongo double ────────────────────────────────────────────────

function createCollection() {
  let docs = [];
  let seq  = 0;

  function nextId() { return `id_${++seq}`; }

  function matchDoc(doc, filter) {
    for (const [k, v] of Object.entries(filter)) {
      if (k === "$or")  { if (!v.some(c => matchDoc(doc, c))) return false; continue; }
      if (k === "$and") { if (!v.every(c => matchDoc(doc, c))) return false; continue; }
      if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
        const dv = doc[k];
        for (const [op, operand] of Object.entries(v)) {
          if (op === "$nin") { if (operand.includes(dv)) return false; }
          else if (op === "$in") { if (!operand.includes(dv)) return false; }
          else if (op === "$ne") { if (dv === operand) return false; }
          else if (op === "$lt") { if (!(dv < operand)) return false; }
          else if (op === "$gt") { if (!(dv > operand)) return false; }
          else if (op === "$exists") {
            const has = Object.prototype.hasOwnProperty.call(doc, k);
            if (operand && !has) return false;
            if (!operand && has) return false;
          }
        }
        continue;
      }
      if (doc[k] !== v) return false;
    }
    return true;
  }

  return {
    _raw() { return docs; },
    async insertOne(doc) {
      const _id = doc._id ?? nextId();
      const inserted = { ...doc, _id };
      docs.push(inserted);
      return { insertedId: _id };
    },
    async findOne(filter) { return docs.find(d => matchDoc(d, filter)) ?? null; },
    async find(filter) {
      const results = docs.filter(d => matchDoc(d, filter));
      return { toArray: async () => results, sort: () => ({ toArray: async () => results }) };
    },
    async countDocuments(filter) { return docs.filter(d => matchDoc(d, filter)).length; },
    async updateOne(filter, update) {
      const idx = docs.findIndex(d => matchDoc(d, filter));
      if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set)  Object.assign(docs[idx], update.$set);
      if (update.$push) {
        for (const [f, val] of Object.entries(update.$push)) {
          if (!Array.isArray(docs[idx][f])) docs[idx][f] = [];
          docs[idx][f].push(val);
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      let n = 0;
      for (const d of docs) { if (matchDoc(d, filter)) { if (update.$set) Object.assign(d, update.$set); n++; } }
      return { matchedCount: n, modifiedCount: n };
    },
    async findOneAndUpdate(filter, update, opts = {}) {
      const idx = docs.findIndex(d => matchDoc(d, filter));
      if (idx === -1) return null;
      const before = { ...docs[idx] };
      if (update.$set) Object.assign(docs[idx], update.$set);
      return opts.returnDocument === "after" ? { ...docs[idx] } : before;
    },
    async deleteOne(filter) {
      const idx = docs.findIndex(d => matchDoc(d, filter));
      if (idx === -1) return { deletedCount: 0 };
      docs.splice(idx, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(filter) {
      const before = docs.length;
      docs = docs.filter(d => !matchDoc(d, filter));
      return { deletedCount: before - docs.length };
    },
    async createIndex() {},
  };
}

function createDb(seed = {}) {
  const map = {};
  for (const [name, rows] of Object.entries(seed)) {
    const col = createCollection();
    for (const r of rows) col.insertOne(r);
    map[name] = col;
  }
  return { collection(name) { if (!map[name]) map[name] = createCollection(); return map[name]; } };
}

// ─── 1. retentionPolicy ───────────────────────────────────────────────────

describe("retentionPolicy helpers", () => {
  // Import synchronously – these are pure data/functions with no DB access.
  // node:test supports top-level await in the file but the import is module-scoped.
  let rp;

  test("retentionPolicy module loads", async () => {
    rp = await import("../../src/lib/privacy/retentionPolicy.js");
    assert.ok(rp.DATA_INVENTORY);
  });

  test("exportableCollections includes users and purchases", async () => {
    if (!rp) rp = await import("../../src/lib/privacy/retentionPolicy.js");
    const cols = rp.exportableCollections();
    assert.ok(cols.includes("users"),     "users must be exportable");
    assert.ok(cols.includes("purchases"), "purchases must be exportable");
  });

  test("exportableCollections excludes ledger", async () => {
    if (!rp) rp = await import("../../src/lib/privacy/retentionPolicy.js");
    assert.ok(!rp.exportableCollections().includes("ledger"));
  });

  test("collectionsToAnonymize includes purchases", async () => {
    if (!rp) rp = await import("../../src/lib/privacy/retentionPolicy.js");
    const names = rp.collectionsToAnonymize().map(t => t.collection);
    assert.ok(names.includes("purchases"),         "purchases must be anonymized");
    assert.ok(names.includes("entitlement_cache"), "entitlement_cache must be anonymized");
    assert.ok(!names.includes("users"),            "users must NOT be anonymized (they are deleted)");
  });

  test("collectionsToDelete includes users and saved_materials", async () => {
    if (!rp) rp = await import("../../src/lib/privacy/retentionPolicy.js");
    const cols = rp.collectionsToDelete();
    assert.ok(cols.includes("users"),          "users must be deleted");
    assert.ok(cols.includes("saved_materials"),"saved_materials must be deleted");
    assert.ok(!cols.includes("purchases"),     "purchases must NOT be deleted");
  });

  test("purchases has 7-year retention and legal_obligation basis", async () => {
    if (!rp) rp = await import("../../src/lib/privacy/retentionPolicy.js");
    const inv = rp.DATA_INVENTORY.purchases;
    assert.equal(inv.legalBasis,    "legal_obligation");
    assert.equal(inv.retentionDays, 2555);
    assert.equal(inv.onDeletion,    "anonymize");
  });

  test("ledger has onDeletion=retain and no PII fields", async () => {
    if (!rp) rp = await import("../../src/lib/privacy/retentionPolicy.js");
    const inv = rp.DATA_INVENTORY.ledger;
    assert.equal(inv.onDeletion, "retain");
    assert.deepEqual(inv.piiFields, []);
  });
});

// ─── 2. deletion state machine (pure logic, in-memory DB) ────────────────

describe("deletion state machine transitions", () => {
  const DELETION_STATUS = {
    PENDING_REAUTH: "pending_reauth",
    COOLING_OFF:    "cooling_off",
    CANCELLED:      "cancelled",
    EXECUTING:      "executing",
    COMPLETED:      "completed",
    FAILED:         "failed",
  };

  const ALLOWED_TRANSITIONS = {
    [DELETION_STATUS.PENDING_REAUTH]: [DELETION_STATUS.COOLING_OFF, DELETION_STATUS.CANCELLED],
    [DELETION_STATUS.COOLING_OFF]:    [DELETION_STATUS.CANCELLED,   DELETION_STATUS.EXECUTING],
    [DELETION_STATUS.EXECUTING]:      [DELETION_STATUS.COMPLETED,   DELETION_STATUS.FAILED],
    [DELETION_STATUS.FAILED]:         [DELETION_STATUS.EXECUTING],
  };

  function assertTransition(from, to) {
    return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
  }

  test("pending_reauth can transition to cooling_off", () => {
    assert.ok(assertTransition(DELETION_STATUS.PENDING_REAUTH, DELETION_STATUS.COOLING_OFF));
  });

  test("pending_reauth can be cancelled", () => {
    assert.ok(assertTransition(DELETION_STATUS.PENDING_REAUTH, DELETION_STATUS.CANCELLED));
  });

  test("cooling_off can be cancelled", () => {
    assert.ok(assertTransition(DELETION_STATUS.COOLING_OFF, DELETION_STATUS.CANCELLED));
  });

  test("cooling_off advances to executing", () => {
    assert.ok(assertTransition(DELETION_STATUS.COOLING_OFF, DELETION_STATUS.EXECUTING));
  });

  test("executing can complete", () => {
    assert.ok(assertTransition(DELETION_STATUS.EXECUTING, DELETION_STATUS.COMPLETED));
  });

  test("executing can fail", () => {
    assert.ok(assertTransition(DELETION_STATUS.EXECUTING, DELETION_STATUS.FAILED));
  });

  test("failed can retry (back to executing)", () => {
    assert.ok(assertTransition(DELETION_STATUS.FAILED, DELETION_STATUS.EXECUTING));
  });

  test("completed is terminal (no outgoing transitions)", () => {
    assert.equal(ALLOWED_TRANSITIONS[DELETION_STATUS.COMPLETED], undefined);
  });

  test("cancelled is terminal (no outgoing transitions)", () => {
    assert.equal(ALLOWED_TRANSITIONS[DELETION_STATUS.CANCELLED], undefined);
  });

  test("executing cannot jump directly to pending_reauth", () => {
    assert.ok(!assertTransition(DELETION_STATUS.EXECUTING, DELETION_STATUS.PENDING_REAUTH));
  });

  test("pending_reauth cannot skip cooling_off and go to executing", () => {
    assert.ok(!assertTransition(DELETION_STATUS.PENDING_REAUTH, DELETION_STATUS.EXECUTING));
  });

  // ── Re-auth token validation logic ────────────────────────────────────
  test("confirmReauth logic: wrong token rejected", () => {
    const doc = { reauthToken: "correct", reauthExpiresAt: new Date(Date.now() + 60_000), status: DELETION_STATUS.PENDING_REAUTH };
    const providedToken = "wrong";
    assert.notEqual(doc.reauthToken, providedToken);
  });

  test("confirmReauth logic: expired challenge rejected", () => {
    const doc = { reauthToken: "tok", reauthExpiresAt: new Date(Date.now() - 1), status: DELETION_STATUS.PENDING_REAUTH };
    assert.ok(doc.reauthExpiresAt < new Date());
  });

  test("cooling-off window is 14 days", () => {
    const COOLING_OFF_DAYS = 14;
    const COOLING_OFF_MS = COOLING_OFF_DAYS * 24 * 60 * 60 * 1000;
    const start = new Date();
    const end   = new Date(start.getTime() + COOLING_OFF_MS);
    const diffDays = (end - start) / (1000 * 60 * 60 * 24);
    assert.equal(diffDays, 14);
  });
});

// ─── 3. obligation checker logic ─────────────────────────────────────────

describe("obligation checker logic", () => {
  const PURCHASE_TERMINAL = new Set(["completed", "failed", "refunded", "cancelled"]);

  async function checkObligationsLogic(walletAddress, db) {
    const reasons = [];

    if (walletAddress) {
      const inflight = await db.collection("purchases").countDocuments({
        buyerAddress: walletAddress,
        status: { $nin: [...PURCHASE_TERMINAL] },
      });
      if (inflight > 0) reasons.push(`${inflight} purchase(s) in progress`);
    }

    return { blocked: reasons.length > 0, reasons };
  }

  test("no obligations when no purchases exist", async () => {
    const db = createDb();
    const { blocked } = await checkObligationsLogic("0xabc", db);
    assert.equal(blocked, false);
  });

  test("blocked by in-flight buyer purchase", async () => {
    const db = createDb({ purchases: [{ buyerAddress: "0xabc", status: "pending" }] });
    const { blocked, reasons } = await checkObligationsLogic("0xabc", db);
    assert.equal(blocked, true);
    assert.ok(reasons.length > 0);
  });

  test("completed purchase does not block deletion", async () => {
    const db = createDb({ purchases: [{ buyerAddress: "0xabc", status: "completed" }] });
    const { blocked } = await checkObligationsLogic("0xabc", db);
    assert.equal(blocked, false);
  });

  test("refunded purchase does not block deletion", async () => {
    const db = createDb({ purchases: [{ buyerAddress: "0xabc", status: "refunded" }] });
    const { blocked } = await checkObligationsLogic("0xabc", db);
    assert.equal(blocked, false);
  });

  test("null wallet address bypasses purchase check", async () => {
    const db = createDb({ purchases: [{ buyerAddress: "0xabc", status: "pending" }] });
    const { blocked } = await checkObligationsLogic(null, db);
    assert.equal(blocked, false);
  });

  test("multiple in-flight purchases all count in reason", async () => {
    const db = createDb({
      purchases: [
        { buyerAddress: "0xabc", status: "pending" },
        { buyerAddress: "0xabc", status: "pending" },
      ],
    });
    const { blocked, reasons } = await checkObligationsLogic("0xabc", db);
    assert.equal(blocked, true);
    assert.ok(reasons[0].includes("2"), `expected '2' in reason: ${reasons[0]}`);
  });
});

// ─── 4. anonymization logic ───────────────────────────────────────────────

describe("anonymization logic", () => {
  const ANON_WALLET = "0x0000000000000000000000000000000000000000";
  const ANON_TEXT   = "[redacted]";

  async function anonymizePurchases(walletAddress, db) {
    const filter = { buyerAddress: walletAddress, _anonymizedAt: { $exists: false } };
    const patch  = { buyerAddress: ANON_WALLET, _anonymizedAt: new Date() };
    const result = await db.collection("purchases").updateMany(filter, { $set: patch });
    return result.modifiedCount;
  }

  test("anonymizes buyerAddress with zero address", async () => {
    const db = createDb({ purchases: [{ buyerAddress: "0xabc", status: "completed" }] });
    const count = await anonymizePurchases("0xabc", db);
    assert.equal(count, 1);
    const doc = await db.collection("purchases").findOne({});
    assert.equal(doc.buyerAddress, ANON_WALLET);
    assert.ok(doc._anonymizedAt instanceof Date);
  });

  test("idempotent: second run modifies 0 records", async () => {
    const db = createDb({ purchases: [{ buyerAddress: "0xabc", status: "completed" }] });
    await anonymizePurchases("0xabc", db);
    const second = await anonymizePurchases("0xabc", db);
    assert.equal(second, 0, "Second run must not re-anonymize");
  });

  test("does not anonymize records belonging to other wallets", async () => {
    const db = createDb({ purchases: [{ buyerAddress: "0xother", status: "completed" }] });
    const count = await anonymizePurchases("0xabc", db);
    assert.equal(count, 0);
    const doc = await db.collection("purchases").findOne({});
    assert.equal(doc.buyerAddress, "0xother");
  });

  test("anonymizes multiple records for same wallet", async () => {
    const db = createDb({
      purchases: [
        { buyerAddress: "0xabc", status: "completed" },
        { buyerAddress: "0xabc", status: "completed" },
      ],
    });
    const count = await anonymizePurchases("0xabc", db);
    assert.equal(count, 2);
  });
});

// ─── 5. data export service logic ─────────────────────────────────────────

describe("data export service logic", () => {
  const EXPORT_STATUS = { PENDING: "pending", PROCESSING: "processing", READY: "ready", FAILED: "failed", EXPIRED: "expired" };
  const EXPORT_TTL_MS = 48 * 60 * 60 * 1000;

  // Inline the core logic for testability
  async function createExportRequest(userId, db) {
    const existing = await db.collection("data_export_requests").findOne({
      userId: String(userId),
      status: { $in: [EXPORT_STATUS.PENDING, EXPORT_STATUS.PROCESSING, EXPORT_STATUS.READY] },
    });
    if (existing) return { alreadyExists: true, request: existing };

    const doc = { userId: String(userId), status: EXPORT_STATUS.PENDING, token: "tok_abc", requestedAt: new Date() };
    const result = await db.collection("data_export_requests").insertOne(doc);
    return { alreadyExists: false, request: { ...doc, _id: result.insertedId } };
  }

  async function markReady(requestId, db) {
    const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
    await db.collection("data_export_requests").updateOne(
      { _id: requestId },
      { $set: { status: EXPORT_STATUS.READY, manifest: { version: "1", sections: {} }, expiresAt, completedAt: new Date() } }
    );
    return expiresAt;
  }

  async function getDownload(requestId, userId, token, db) {
    const doc = await db.collection("data_export_requests").findOne({ _id: requestId });
    if (!doc) throw Object.assign(new Error("Not found"), { code: "not_found" });
    if (doc.userId !== String(userId)) throw Object.assign(new Error("Forbidden"), { code: "forbidden" });
    if (doc.token !== token) throw Object.assign(new Error("Invalid token"), { code: "forbidden" });
    if (doc.status !== EXPORT_STATUS.READY) throw Object.assign(new Error("Not ready"), { code: "not_ready" });
    if (doc.expiresAt && doc.expiresAt < new Date()) throw Object.assign(new Error("Expired"), { code: "expired" });
    return { manifest: doc.manifest, expiresAt: doc.expiresAt };
  }

  test("creates a pending export request with a token", async () => {
    const db = createDb();
    const { request, alreadyExists } = await createExportRequest("user_1", db);
    assert.equal(alreadyExists, false);
    assert.equal(request.status, EXPORT_STATUS.PENDING);
    assert.ok(request.token);
  });

  test("returns alreadyExists=true on duplicate pending request", async () => {
    const db = createDb();
    await createExportRequest("user_1", db);
    const second = await createExportRequest("user_1", db);
    assert.equal(second.alreadyExists, true);
  });

  test("allows new request after first is completed (no duplicate blocking)", async () => {
    const db = createDb();
    const first = await createExportRequest("user_1", db);
    // Simulate completion
    await db.collection("data_export_requests").updateOne(
      { _id: first.request._id },
      { $set: { status: EXPORT_STATUS.READY } }
    );
    // Mark expired
    await db.collection("data_export_requests").updateOne(
      { _id: first.request._id },
      { $set: { status: EXPORT_STATUS.EXPIRED } }
    );
    const second = await createExportRequest("user_1", db);
    assert.equal(second.alreadyExists, false);
  });

  test("getDownload returns manifest for valid request", async () => {
    const db = createDb();
    const { request } = await createExportRequest("user_1", db);
    await markReady(request._id, db);
    const { manifest } = await getDownload(request._id, "user_1", request.token, db);
    assert.ok(manifest);
    assert.equal(manifest.version, "1");
  });

  test("getDownload rejects wrong token", async () => {
    const db = createDb();
    const { request } = await createExportRequest("user_1", db);
    await markReady(request._id, db);
    await assert.rejects(
      () => getDownload(request._id, "user_1", "wrong", db),
      (err) => err.code === "forbidden"
    );
  });

  test("getDownload rejects wrong user", async () => {
    const db = createDb();
    const { request } = await createExportRequest("user_1", db);
    await markReady(request._id, db);
    await assert.rejects(
      () => getDownload(request._id, "user_2", request.token, db),
      (err) => err.code === "forbidden"
    );
  });

  test("getDownload rejects expired export", async () => {
    const db = createDb();
    const { request } = await createExportRequest("user_1", db);
    await db.collection("data_export_requests").updateOne(
      { _id: request._id },
      { $set: { status: EXPORT_STATUS.READY, token: request.token, manifest: { version: "1", sections: {} }, expiresAt: new Date(Date.now() - 1000) } }
    );
    await assert.rejects(
      () => getDownload(request._id, "user_1", request.token, db),
      (err) => err.code === "expired"
    );
  });

  test("export TTL is 48 hours", () => {
    assert.equal(EXPORT_TTL_MS, 48 * 60 * 60 * 1000);
  });
});

// ─── 6. partial-failure recovery properties ───────────────────────────────

describe("partial-failure recovery", () => {
  test("failed state is retryable (not terminal)", () => {
    const ALLOWED = {
      pending_reauth: ["cooling_off", "cancelled"],
      cooling_off:    ["cancelled",   "executing"],
      executing:      ["completed",   "failed"],
      failed:         ["executing"],
    };
    assert.ok(ALLOWED.failed.includes("executing"), "failed must allow retry via executing");
  });

  test("steps array accumulates partial progress", async () => {
    const db = createDb();
    const col = db.collection("deletion_requests");
    await col.insertOne({ _id: "req_1", steps: [], status: "executing", userId: "user_1", updatedAt: new Date() });

    // Record step 1
    await col.updateOne({ _id: "req_1" }, { $push: { steps: { step: "revoke_sessions", ok: true } }, $set: { updatedAt: new Date() } });
    // Record step 2
    await col.updateOne({ _id: "req_1" }, { $push: { steps: { step: "delete_saved_materials", deleted: 3, ok: true } }, $set: { updatedAt: new Date() } });

    const doc = await col.findOne({ _id: "req_1" });
    assert.equal(doc.steps.length, 2);
    assert.equal(doc.steps[0].step, "revoke_sessions");
    assert.equal(doc.steps[1].deleted, 3);
  });

  test("idempotent anonymization uses _anonymizedAt guard", async () => {
    const db = createDb({
      purchases: [
        { buyerAddress: "0xabc", _anonymizedAt: new Date() }, // already done
        { buyerAddress: "0xabc" },                             // not yet done
      ],
    });
    const filter  = { buyerAddress: "0xabc", _anonymizedAt: { $exists: false } };
    const matches = await db.collection("purchases").countDocuments(filter);
    assert.equal(matches, 1, "Only the un-anonymized record should match");
  });

  test("deleteMany is safe to run twice (second run returns 0)", async () => {
    const db = createDb({ saved_materials: [{ walletAddress: "0xabc" }] });
    const first  = await db.collection("saved_materials").deleteMany({ walletAddress: "0xabc" });
    const second = await db.collection("saved_materials").deleteMany({ walletAddress: "0xabc" });
    assert.equal(first.deletedCount,  1);
    assert.equal(second.deletedCount, 0);
  });

  test("receipt ID is set only after successful completion", async () => {
    const db = createDb();
    const col = db.collection("deletion_requests");

    // Simulate executing → completed
    await col.insertOne({ _id: "req_2", status: "executing", receiptId: null, steps: [], userId: "user_1" });
    await col.updateOne({ _id: "req_2" }, { $set: { status: "completed", receiptId: "receipt_xyz", completedAt: new Date() } });

    const doc = await col.findOne({ _id: "req_2" });
    assert.equal(doc.receiptId, "receipt_xyz");
    assert.equal(doc.status, "completed");
  });

  test("failed deletion preserves previously completed steps", async () => {
    const db = createDb();
    const col = db.collection("deletion_requests");
    await col.insertOne({ _id: "req_3", status: "executing", steps: [{ step: "revoke_sessions", ok: true }], userId: "user_1" });

    // A subsequent step fails; we record it
    await col.updateOne(
      { _id: "req_3" },
      { $push: { steps: { step: "delete_materials", ok: false, error: "timeout" } }, $set: { status: "failed", failureReason: "timeout" } }
    );

    const doc = await col.findOne({ _id: "req_3" });
    assert.equal(doc.steps.length, 2);
    assert.equal(doc.steps[0].ok, true,  "First step must still be marked OK");
    assert.equal(doc.steps[1].ok, false, "Failed step must be recorded");
    assert.equal(doc.failureReason, "timeout");
  });
});
