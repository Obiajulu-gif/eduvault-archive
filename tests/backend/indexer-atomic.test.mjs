import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyIndexedEvent,
  getIndexerHealth,
  runIndexerBatch,
} from "../../src/lib/indexer/stellarIndexer.js";

function createMockCollection() {
  const records = new Map();

  return {
    records,
    async findOne(query) {
      if (query._id) return records.get(query._id) || null;
      for (const doc of records.values()) {
        let match = true;
        for (const [key, val] of Object.entries(query)) {
          if (doc[key] !== val) {
            match = false;
            break;
          }
        }
        if (match) return doc;
      }
      return null;
    },
    async insertOne(doc) {
      if (records.has(doc._id)) {
        const error = new Error("duplicate key error");
        error.code = 11000;
        throw error;
      }
      records.set(doc._id, { ...doc });
    },
    async updateOne(query, update, options = {}) {
      let key = query._id;
      if (!key && query.materialId && query.buyerAddress) {
        key = `${query.materialId}:${query.buyerAddress}`;
      } else if (!key && query.deliveryId) {
        key = query.deliveryId;
      } else if (!key && query.materialId) {
        key = query.materialId;
      }

      const existing = records.get(key) || null;
      if (!existing && !options.upsert) return { modifiedCount: 0 };

      const current = existing || {};
      const next = {
        ...current,
        ...(update.$setOnInsert && !existing ? update.$setOnInsert : {}),
        ...(update.$set || {}),
      };
      if (!next._id) next._id = key;
      records.set(key, next);
      return { modifiedCount: 1, upsertedId: key };
    },
    async deleteOne(query) {
      if (query._id) records.delete(query._id);
    },
    find(query = {}) {
      const items = Array.from(records.values()).filter((doc) => {
        for (const [k, v] of Object.entries(query)) {
          if (doc[k] !== v) return false;
        }
        return true;
      });
      return {
        async toArray() {
          return items;
        },
      };
    },
  };
}

function createMockDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, createMockCollection());
      return collections.get(name);
    },
  };
}

test("Issue #631: applyIndexedEvent writes raw event, projections, and outbox atomically with ledger identity", async () => {
  const db = createMockDb();
  const event = {
    id: "ledger:100:tx1:0",
    type: "purchase.completed",
    materialId: "mat-100",
    buyerAddress: "GBUYER100",
    sellerAddress: "GSELLER100",
    purchaseId: "p-100",
    amount: "10",
    asset: "XLM",
    ledger: 100,
    transactionHash: "tx100hash",
  };

  const result = await applyIndexedEvent(db, event);
  assert.equal(result.skipped, false);

  const syncEvent = await db.collection("sync_events").findOne({ _id: "ledger:100:tx1:0" });
  assert.ok(syncEvent);
  assert.equal(syncEvent.indexedLedger, 100);
  assert.equal(syncEvent.txHash, "tx100hash");

  const purchase = await db.collection("purchases").findOne({ materialId: "mat-100", buyerAddress: "gbuyer100" });
  assert.ok(purchase);
  assert.equal(purchase.status, "settled");
  assert.equal(purchase.indexedLedger, 100);
  assert.equal(purchase.chainTxHash, "tx100hash");

  const entitlement = await db.collection("entitlement_cache").findOne({ materialId: "mat-100", buyerAddress: "gbuyer100" });
  assert.ok(entitlement);
  assert.equal(entitlement.state, "finalized");
  assert.equal(entitlement.indexedLedger, 100);

  const outboxItem = await db.collection("side_effect_outbox").findOne({ deliveryId: `side-effect:email:purchase_receipt:${String(purchase._id)}` });
  assert.ok(outboxItem);
  assert.equal(outboxItem.status, "pending");
});

test("Issue #631: replaying an already indexed event is idempotent and does not duplicate outbox entries", async () => {
  const db = createMockDb();
  const event = {
    id: "ledger:200:tx2:0",
    type: "purchase.completed",
    materialId: "mat-200",
    buyerAddress: "GBUYER200",
    purchaseId: "p-200",
    ledger: 200,
  };

  const res1 = await applyIndexedEvent(db, event);
  assert.equal(res1.skipped, false);

  const res2 = await applyIndexedEvent(db, event);
  assert.equal(res2.skipped, true);

  const outboxRecords = Array.from(db.collection("side_effect_outbox").records.values());
  assert.equal(outboxRecords.length, 1);
});

test("Issue #631: getIndexerHealth reports lag, checkpoint generation, and blocked events", async () => {
  const db = createMockDb();
  await db.collection("sync_state").updateOne(
    { _id: "stellar:events" },
    { $set: { cursor: "cur-500", lastLedger: 500, updatedAt: new Date() }, $setOnInsert: {} },
    { upsert: true }
  );

  await db.collection("dead_letter_events").updateOne(
    { _id: "dl-1" },
    { $set: { status: "retryable", retryCount: 2 }, $setOnInsert: {} },
    { upsert: true }
  );

  await db.collection("dead_letter_events").updateOne(
    { _id: "dl-2" },
    { $set: { status: "failed", retryCount: 4 }, $setOnInsert: {} },
    { upsert: true }
  );

  const health = await getIndexerHealth(db, { source: "stellar", currentLedger: 510 });

  assert.equal(health.lastLedger, 500);
  assert.equal(health.lag, 10);
  assert.equal(health.deadLetterRetryableCount, 1);
  assert.equal(health.deadLetterFailedCount, 1);
  assert.equal(health.blockedEventsCount, 2);
});
