import assert from "node:assert/strict";
import { test } from "node:test";
import { xdr, nativeToScVal, Address, Keypair } from "@stellar/stellar-sdk";

import {
  runIndexerBatch,
  reprocessDeadLetters,
  classifyIndexerError,
} from "../../src/lib/indexer/stellarIndexer.js";
import { COLLECTIONS } from "../../src/lib/backend/schemaContracts.js";

function toBase64(scVal) {
  return scVal.toXDR("base64");
}

function symbolTopic(name) {
  return toBase64(nativeToScVal(name, { type: "symbol" }));
}

function bytesTopic(buffer) {
  return toBase64(nativeToScVal(buffer, { type: "bytes" }));
}

function addressTopic(strkey) {
  return toBase64(new Address(strkey).toScVal());
}

function vecValue(scVals) {
  return toBase64(xdr.ScVal.scvVec(scVals));
}

function createCollection(failures = {}) {
  const records = new Map();
  return {
    records,
    async findOne(query) {
      if (query._id) return records.get(query._id) || null;
      return null;
    },
    async insertOne(doc) {
      if (failures.insertOne) {
        const key = typeof failures.insertOne === 'function' ? failures.insertOne('insertOne', doc) : failures.insertOne;
        if (key) {
          const error = new Error('transient');
          error.code = 500;
          throw error;
        }
      }
      if (records.has(doc._id)) {
        const error = new Error("duplicate");
        error.code = 11000;
        throw error;
      }
      records.set(doc._id, doc);
    },
    async updateOne(query, update, options = {}) {
      const key = query._id || `${query.materialId}:${query.buyerAddress || ""}`;
      if (failures.updateOne) {
        const shouldFail = typeof failures.updateOne === 'function' ? failures.updateOne('updateOne', { query, update, options, key }) : failures.updateOne;
        if (shouldFail) {
          const error = new Error('transient-update');
          error.code = 500;
          throw error;
        }
      }
      const current = records.get(key) || {};
      if (!records.has(key) && !options.upsert) return;
      records.set(key, {
        ...current,
        ...(update.$setOnInsert || {}),
        ...(update.$set || {}),
      });
    },
    async deleteOne(query) {
      if (query._id) records.delete(query._id);
    },
  };
}

function createDbWithFailures(failures = {}) {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, createCollection(failures[name] || failures));
      return collections.get(name);
    },
  };
}

test('runIndexerBatch records transient failures to dead-letter and supports retries', async () => {
  const failures = {
    // make purchases.updateOne fail the first two attempts by counting calls
    updateOne: (op, info) => {
      if (info.key && info.key.startsWith('material-1:')) {
        failures._calls = (failures._calls || 0) + 1;
        // fail first two attempts
        if (failures._calls <= 2) return true;
      }
      return false;
    },
  };

  const db = createDbWithFailures({
    [COLLECTIONS.syncEvents]: {},
    [COLLECTIONS.purchases]: failures,
    [COLLECTIONS.entitlementCache]: {},
    [COLLECTIONS.syncState]: {},
    [COLLECTIONS.deadLetterEvents]: {},
  });

  const event = {
    id: 'ledger:tx:1',
    type: 'purchase.completed',
    materialId: 'material-1',
    buyerAddress: 'GBUYER',
    transactionHash: 'tx',
  };

  const result1 = await runIndexerBatch({ db, eventSource: { async getEvents() { return { events: [event], nextCursor: null }; } } });
  // operation failed, so nothing applied but dead-letter must be present
  const dl = await db.collection(COLLECTIONS.deadLetterEvents).findOne({ _id: 'ledger:tx:1' });
  assert(dl, 'dead-letter entry created');
  assert.equal(dl.retryCount, 1);
  assert.equal(dl.status, 'retryable');

  // set retries threshold to 1 so second attempt marks failed
  process.env.INDEXER_MAX_RETRIES = '1';

  const result2 = await runIndexerBatch({ db, eventSource: { async getEvents() { return { events: [event], nextCursor: null }; } } });
  const dl2 = await db.collection(COLLECTIONS.deadLetterEvents).findOne({ _id: 'ledger:tx:1' });
  assert(dl2, 'dead-letter still present');
  assert.equal(dl2.retryCount, 2);
  assert.equal(dl2.status, 'failed');

  // reprocessing is handled by maintainers via `scripts/reprocess-deadletter.mjs`
});

test('classifyIndexerError classifies errors correctly', () => {
  // Transient codes
  assert.equal(classifyIndexerError({ code: "ECONNRESET" }), "transient");
  assert.equal(classifyIndexerError({ code: "ECONNREFUSED" }), "transient");
  assert.equal(classifyIndexerError({ code: "ETIMEDOUT" }), "transient");
  assert.equal(classifyIndexerError({ code: 11600 }), "transient");
  assert.equal(classifyIndexerError({ code: "ENOTFOUND" }), "transient");
  assert.equal(classifyIndexerError({ code: "EAI_AGAIN" }), "transient");

  // HTTP-style status boundaries
  assert.equal(classifyIndexerError({ status: 429 }), "transient");
  assert.equal(classifyIndexerError({ response: { status: 429 } }), "transient");
  assert.equal(classifyIndexerError({ code: 429 }), "transient");
  assert.equal(classifyIndexerError({ status: 500 }), "transient");
  assert.equal(classifyIndexerError({ status: 599 }), "transient");
  
  assert.equal(classifyIndexerError({ status: 499 }), "poison");
  assert.equal(classifyIndexerError({ status: 600 }), "poison");

  // Conflicting status vs response.status (response.status takes precedence)
  assert.equal(classifyIndexerError({ status: 500, response: { status: 499 } }), "poison");
  assert.equal(classifyIndexerError({ status: 499, response: { status: 500 } }), "transient");

  // Transient message substrings
  assert.equal(classifyIndexerError(new Error("Connection timeout")), "transient");
  assert.equal(classifyIndexerError(new Error("Network blip")), "transient");
  assert.equal(classifyIndexerError(new Error("econnreset encountered")), "transient");
  assert.equal(classifyIndexerError(new Error("Socket closed")), "transient");
  assert.equal(classifyIndexerError(new Error("Topology was destroyed")), "transient");
  assert.equal(classifyIndexerError(new Error("TypeError: fetch failed")), "transient");
  assert.equal(classifyIndexerError(new Error("failed to fetch content")), "transient");
  assert.equal(classifyIndexerError(new Error("DNS resolution failed")), "transient");
  assert.equal(classifyIndexerError(new Error("getaddrinfo ENOTFOUND")), "transient");

  // Poison / Unrecognized errors
  assert.equal(classifyIndexerError(new Error("SyntaxError: Unexpected token")), "poison");
  assert.equal(classifyIndexerError({}), "poison");
  assert.equal(classifyIndexerError(null), "poison");
});

test('runIndexerBatch treats poison error as failed immediately and transient as retryable', async () => {
  const db = createDbWithFailures({
    [COLLECTIONS.syncEvents]: {},
    [COLLECTIONS.purchases]: {
      updateOne: () => {
        throw new Error('Poison validation error');
      }
    },
    [COLLECTIONS.entitlementCache]: {},
    [COLLECTIONS.syncState]: {},
    [COLLECTIONS.deadLetterEvents]: {},
  });

  const buyer = Keypair.random().publicKey();
  const seller = Keypair.random().publicKey();
  const asset = Keypair.random().publicKey();
  const materialId = Buffer.alloc(32, 7);

  const rawEvent = {
    id: 'ledger:tx:2',
    ledger: 123456,
    txHash: "abcd1234ef",
    ledgerClosedAt: "2026-07-25T00:00:00Z",
    contractId: "CCONTRACTID000000000000000000000000000000000000000000",
    topic: [
      symbolTopic("purchase"),
      symbolTopic("completed"),
      toBase64(nativeToScVal(42n, { type: "u64" })),
      bytesTopic(materialId),
      addressTopic(buyer),
    ],
    value: vecValue([
      new Address(seller).toScVal(),
      new Address(asset).toScVal(),
      nativeToScVal(5_000_000n, { type: "i128" }),
      nativeToScVal(50_000n, { type: "i128" }),
      nativeToScVal(4_950_000n, { type: "i128" }),
      xdr.ScVal.scvBool(true),
      nativeToScVal(Buffer.alloc(16, 9), { type: "bytes" }),
    ]),
  };

  // Run the batch once
  await runIndexerBatch({ db, eventSource: { async getEvents() { return { events: [rawEvent], nextCursor: null }; } } });
  
  const dl = await db.collection(COLLECTIONS.deadLetterEvents).findOne({ _id: 'ledger:tx:2' });
  assert(dl, 'dead-letter entry created');
  assert.equal(dl.retryCount, 1);
  assert.equal(dl.status, 'failed'); // Marked failed on the first try because it is classified as poison!
});
