import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyIndexedEvent,
  createJsonRpcEventSource,
  eventId,
  runIndexerBatch,
} from "../../src/lib/indexer/stellarIndexer.js";

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
      const key = query._id || `${query.materialId}:${query.buyerAddress || ""}`;
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

test("event identity includes network, contract, ledger, transaction, and zero position", () => {
  assert.equal(
    eventId({
      network: "testnet",
      contractId: "CABC",
      ledger: 123,
      transactionHash: "tx-hash",
      index: 0,
    }),
    "testnet:CABC:123:tx-hash:0",
  );
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

  // An empty page is a short page, so the indexer reports itself drained and
  // caught up rather than lagging by the full height of the chain.
  assert.deepEqual(result, {
    applied: 0,
    skipped: 0,
    nextCursor: "cursor-2",
    ledgerLag: 0,
    drained: true,
  });
  assert.equal((await db.collection("sync_state").findOne({ _id: "stellar:events" })).cursor, "cursor-2");
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
