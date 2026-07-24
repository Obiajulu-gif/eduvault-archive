import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEscrowEvent } from "../../src/lib/indexer/escrowIndexer.js";

function createCollection() {
  const records = new Map();

  return {
    records,
    async findOne(query) {
      if (query._id) return records.get(query._id) || null;
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
      const key = query._id || query.payoutId || query.milestoneId || query.escrowId;
      const current = records.get(key) || {};
      if (!records.has(key) && !options.upsert) return;
      records.set(key, {
        ...current,
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      });
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

test("applyEscrowEvent applies escrow.funded idempotently", async () => {
  const db = createDb();
  const event = {
    id: "tx1",
    type: "escrow.funded",
    escrowId: "escrow-1",
    engager: "GUSER1",
    amount: "1000",
    asset: "USDC",
    transactionHash: "hash1",
  };

  const result1 = await applyEscrowEvent(db, event);
  assert.equal(result1.skipped, false);
  
  const result2 = await applyEscrowEvent(db, event);
  assert.equal(result2.skipped, true);

  const escrows = db.collection("escrows");
  const record = escrows.records.get("escrow-1");
  assert.equal(record.status, "funded");
  assert.equal(record.engager, "GUSER1");
});

test("applyEscrowEvent applies milestone.approved and escrow.released", async () => {
  const db = createDb();
  
  await applyEscrowEvent(db, {
    id: "tx-fund",
    type: "escrow.funded",
    escrowId: "escrow-2",
    engager: "GUSER1",
    amount: "500",
    asset: "USDC",
  });

  await applyEscrowEvent(db, {
    id: "tx2",
    type: "milestone.approved",
    escrowId: "escrow-2",
    milestoneId: "1",
    approver: "GUSER1",
  });
  
  const milestones = db.collection("milestones");
  const milestoneRecord = milestones.records.get("1");
  assert.equal(milestoneRecord.escrowId, "escrow-2");
  assert.equal(milestoneRecord.status, "approved");

  await applyEscrowEvent(db, {
    id: "tx3",
    type: "escrow.released",
    escrowId: "escrow-2",
    recipient: "GCREATOR",
    amount: "500",
  });

  const escrows = db.collection("escrows");
  const escrowRecord = escrows.records.get("escrow-2");
  assert.equal(escrowRecord.status, "released");

  const payouts = db.collection("payouts");
  const payoutRecord = payouts.records.get("escrow-2-GCREATOR");
  assert.equal(payoutRecord.recipient, "GCREATOR");
  assert.equal(payoutRecord.amount, "500");
  assert.equal(payoutRecord.status, "claimed");
});
