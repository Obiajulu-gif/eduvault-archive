import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyIndexedEvent,
  createJsonRpcEventSource,
  runIndexerBatch,
} from "../../src/lib/indexer/stellarIndexer.js";

function queryKey(query) {
  if (query && typeof query === "object" && query._id !== undefined) return query._id;
  if (query && typeof query === "object") {
    const entries = Object.entries(query).sort(([a], [b]) => a.localeCompare(b));
    return `q:${JSON.stringify(entries)}`;
  }
  return String(query);
}

function createCollection() {
  const records = new Map();

  return {
    records,
    async findOne(query) {
      if (query._id) return records.get(query._id) || null;
      for (const doc of records.values()) {
        if (Object.entries(query).every(([k, v]) => doc[k] === v)) return doc;
      }
      return null;
    },
    async insertOne(doc) {
      if (records.has(doc._id)) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      records.set(doc._id, doc);
    },
    async updateOne(query, update, options = {}) {
      // Mirror MongoDB semantics: update an existing record that matches the
      // query in place (preserving its key), and only fall back to a
      // query-keyed upsert when nothing matches.
      const matches = (doc) => Object.entries(query).every(([k, v]) => doc[k] === v);
      for (const doc of records.values()) {
        if (matches(doc)) {
          Object.assign(doc, update.$setOnInsert || {}, update.$set || {});
          return;
        }
      }
      const key = queryKey(query);
      const current = records.get(key) || {};
      if (!records.has(key) && !options.upsert) return;
      records.set(key, {
        ...current,
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      });
    },
    _all() {
      return Array.from(records.values());
    },
  };
}

function createDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, createCollection());
      return collections.get(name);
    },
  };
}

test("applyIndexedEvent writes purchases and entitlement cache idempotently", async () => {
  const db = createDb();
  const event = {
    id: "ledger:tx:1",
    type: "purchase.completed",
    materialId: "material-1",
    buyerAddress: "GBUYER",
    transactionHash: "tx",
  };

  assert.equal((await applyIndexedEvent(db, event)).skipped, false);
  assert.equal((await applyIndexedEvent(db, event)).skipped, true);
});

test("runIndexerBatch stores cursor progress", async () => {
  const db = createDb();
  const result = await runIndexerBatch({
    db,
    eventSource: {
      async getEvents() {
        return { events: [], nextCursor: "cursor-2", lastLedger: 123 };
      },
    },
  });

  assert.deepEqual(result, { applied: 0, skipped: 0, nextCursor: "cursor-2", hadFailure: false });
  assert.equal((await db.collection("sync_state").findOne({ _id: "stellar:events" })).cursor, "cursor-2");
});

function seededPurchase(db, { materialId, purchaseId, buyerAddress }) {
  db.collection("purchases").updateOne(
    { materialId, purchaseId },
    {
      $set: {
        materialId,
        purchaseId,
        buyerAddress,
        indexedLedger: 50,
        settlementState: "Pending",
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

function findFirst(db, collection, predicate) {
  return db.collection(collection)._all().find(predicate) || null;
}

test("dispute.resolved (RefundBuyer) refunds the purchase and revokes entitlement", async () => {
  const db = createDb();
  seededPurchase(db, { materialId: "m1", purchaseId: "p1", buyerAddress: "gbuyer" });

  await applyIndexedEvent(db, {
    id: "ledger:tx:10",
    type: "dispute.resolved",
    materialId: "m1",
    purchaseId: "p1",
    resolution: "RefundBuyer",
    ledger: 60,
  });

  const purchase = findFirst(db, "purchases", (p) => p.purchaseId === "p1");
  assert.equal(purchase.settlementState, "Refunded");
  assert.equal(purchase.disputeResolution, "RefundBuyer");

  const entitlement = findFirst(db, "entitlement_cache", (e) => e.materialId === "m1");
  assert.equal(entitlement.state, "revoked");
  assert.equal(entitlement.active, false);
});

test("dispute.resolved (ReleaseToCreator) releases funds and keeps entitlement active", async () => {
  const db = createDb();
  seededPurchase(db, { materialId: "m1", purchaseId: "p1", buyerAddress: "gbuyer" });

  await applyIndexedEvent(db, {
    id: "ledger:tx:11",
    type: "dispute.resolved",
    materialId: "m1",
    purchaseId: "p1",
    resolution: "ReleaseToCreator",
    ledger: 60,
  });

  const purchase = findFirst(db, "purchases", (p) => p.purchaseId === "p1");
  assert.equal(purchase.settlementState, "Released");

  const entitlement = findFirst(db, "entitlement_cache", (e) => e.materialId === "m1");
  assert.equal(entitlement.active, true);
  assert.equal(entitlement.settlementState, "Released");
});

test("escrow.released marks the purchase released", async () => {
  const db = createDb();
  seededPurchase(db, { materialId: "m1", purchaseId: "p1", buyerAddress: "gbuyer" });

  await applyIndexedEvent(db, {
    id: "ledger:tx:12",
    type: "escrow.released",
    materialId: "m1",
    purchaseId: "p1",
    ledger: 60,
  });

  const purchase = findFirst(db, "purchases", (p) => p.purchaseId === "p1");
  assert.equal(purchase.settlementState, "Released");
  assert.ok(purchase.escrowReleasedAt instanceof Date);
});

test("payout.distributed records the off-chain payout", async () => {
  const db = createDb();

  await applyIndexedEvent(db, {
    id: "ledger:tx:13",
    type: "payout.distributed",
    purchaseId: "p1",
    materialId: "m1",
    recipient: "GCREATOR",
    role: "seller",
    amount: "100",
    ledger: 60,
  });

  const payout = findFirst(db, "payouts", (p) => p.purchaseId === "p1");
  assert.equal(payout.recipient, "gcreator");
  assert.equal(payout.amount, "100");
});

test("purchase.bulk_completed records the bulk purchase", async () => {
  const db = createDb();

  await applyIndexedEvent(db, {
    id: "ledger:tx:14",
    type: "purchase.bulk_completed",
    materialId: "m1",
    purchaser: "GINSTITUTION",
    recipientCount: 25,
    totalPaid: "2500",
    ledger: 60,
    transactionHash: "tx-bulk",
  });

  const bulk = findFirst(db, "bulk_purchases", (b) => b.materialId === "m1");
  assert.equal(bulk.purchaser, "GINSTITUTION");
  assert.equal(bulk.recipientCount, 25);
  assert.ok(bulk._id.startsWith("bulk:tx-bulk:"));
});

test("creator.tier_updated records the creator tier", async () => {
  const db = createDb();

  await applyIndexedEvent(db, {
    id: "ledger:tx:15",
    type: "creator.tier_updated",
    creator: "GCREATOR",
    tier: "Tier1",
    ledger: 60,
  });

  const tier = findFirst(db, "creator_tiers", (t) => t.creator === "GCREATOR");
  assert.equal(tier.tier, "Tier1");
  assert.equal(tier._id, "gcreator");
});

test("admin transfer events record the handover audit trail", async () => {
  const db = createDb();

  await applyIndexedEvent(db, {
    id: "ledger:tx:16",
    type: "admin.transfer_initiated",
    from: "GADMIN1",
    pendingAdmin: "GADMIN2",
    ledger: 60,
  });
  await applyIndexedEvent(db, {
    id: "ledger:tx:17",
    type: "admin.transfer_accepted",
    newAdmin: "GADMIN2",
    ledger: 61,
  });

  const initiated = findFirst(db, "admin_transfers", (t) => t.status === "initiated");
  assert.equal(initiated.pendingAdmin, "GADMIN2");
  const accepted = findFirst(db, "admin_transfers", (t) => t.status === "accepted");
  assert.equal(accepted.newAdmin, "GADMIN2");
});

test("scholarship.credits_issued mirrors the on-chain grant", async () => {
  const db = createDb();

  await applyIndexedEvent(db, {
    id: "ledger:tx:18",
    type: "scholarship.credits_issued",
    grantId: "g1",
    learner: "GLEARNER",
    issuer: "GISSuer",
    amount: "500",
    ledger: 60,
  });

  const grant = findFirst(db, "scholarship_grants", (g) => g.grantId === "g1");
  assert.equal(grant.learner, "glearner");
  assert.equal(grant.amount, "500");
  assert.equal(grant.remainingAmount, "500");
  assert.equal(grant.active, true);
});

test("scholarship.credits_redeemed records the redemption and updates the grant balance", async () => {
  const db = createDb();
  await applyIndexedEvent(db, {
    id: "ledger:tx:19",
    type: "scholarship.credits_issued",
    grantId: "g1",
    learner: "GLEARNER",
    issuer: "GISSUER",
    amount: "500",
    ledger: 60,
  });

  await applyIndexedEvent(db, {
    id: "ledger:tx:20",
    type: "scholarship.credits_redeemed",
    redemptionId: "r1",
    learner: "GLEARNER",
    materialId: "m1",
    creditsUsed: "100",
    remainingCredits: "400",
    ledger: 61,
  });

  const redemption = findFirst(db, "scholarship_redemptions", (r) => r.redemptionId === "r1");
  assert.equal(redemption.creditsUsed, "100");
  assert.equal(redemption.materialId, "m1");

  const grant = findFirst(db, "scholarship_grants", (g) => g.grantId === "g1");
  assert.equal(grant.remainingAmount, "400");
});

test("scholarship.grant_revoked deactivates the grant", async () => {
  const db = createDb();
  await applyIndexedEvent(db, {
    id: "ledger:tx:21",
    type: "scholarship.credits_issued",
    grantId: "g1",
    learner: "GLEARNER",
    issuer: "GISSUER",
    amount: "500",
    ledger: 60,
  });

  await applyIndexedEvent(db, {
    id: "ledger:tx:22",
    type: "scholarship.grant_revoked",
    grantId: "g1",
    learner: "GLEARNER",
    issuer: "GISSUER",
    creditsRevoked: "500",
    ledger: 61,
  });

  const grant = findFirst(db, "scholarship_grants", (g) => g.grantId === "g1");
  assert.equal(grant.active, false);
  assert.equal(grant.creditsRevoked, "500");
});

test("scholarship.cost_updated records the credit cost on the material", async () => {
  const db = createDb();

  await applyIndexedEvent(db, {
    id: "ledger:tx:23",
    type: "scholarship.cost_updated",
    materialId: "m1",
    creditCost: "20",
    ledger: 60,
  });

  const material = findFirst(db, "materials", (m) => m.materialId === "m1");
  assert.equal(material.scholarshipCreditCost, "20");
});

test("scholarship.issuer_updated records the issuer config", async () => {
  const db = createDb();

  await applyIndexedEvent(db, {
    id: "ledger:tx:24",
    type: "scholarship.issuer_updated",
    issuer: "GISSUER",
    enabled: true,
    ledger: 60,
  });

  const config = await db.collection("scholarship_config").findOne({ _id: "issuer" });
  assert.equal(config.issuer, "GISSUER");
  assert.equal(config.enabled, true);
});

test("createJsonRpcEventSource supports multiple contract ids", async () => {
  let rpcBody = null;
  const eventSource = createJsonRpcEventSource({
    rpcUrl: "https://rpc.example.test",
    contractId: ["registry-id", "purchase-manager-id"],
    fetchImpl: async (_url, init) => {
      rpcBody = JSON.parse(init.body);
      return {
        async json() {
          return { result: { events: [], cursor: "cursor-3", latestLedger: 456 } };
        },
      };
    },
  });

  const result = await eventSource.getEvents({ cursor: "cursor-2", limit: 25 });

  assert.deepEqual(rpcBody.params.filters, [
    { contractIds: ["registry-id", "purchase-manager-id"] },
  ]);
  assert.deepEqual(result, { events: [], nextCursor: "cursor-3", lastLedger: 456 });
});
