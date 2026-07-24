import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runIndexerBatch,
  reprocessDeadLetters,
} from "../../src/lib/indexer/stellarIndexer.js";
import { COLLECTIONS } from "../../src/lib/backend/schemaContracts.js";

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
  assert.equal(
    (await db.collection(COLLECTIONS.syncEvents).findOne({ _id: 'ledger:tx:1' })).status,
    'failed',
    'a partial receipt is never reported as successfully projected',
  );

  // set retries threshold to 1 so second attempt marks failed
  process.env.INDEXER_MAX_RETRIES = '1';

  const result2 = await runIndexerBatch({ db, eventSource: { async getEvents() { return { events: [event], nextCursor: null }; } } });
  const dl2 = await db.collection(COLLECTIONS.deadLetterEvents).findOne({ _id: 'ledger:tx:1' });
  assert(dl2, 'dead-letter still present');
  assert.equal(dl2.retryCount, 2);
  assert.equal(dl2.status, 'failed');

  const result3 = await runIndexerBatch({ db, eventSource: { async getEvents() { return { events: [event], nextCursor: null }; } } });
  assert.equal(result3.applied, 1, 'the recoverable receipt replays its projections');
  assert.equal(
    (await db.collection(COLLECTIONS.syncEvents).findOne({ _id: 'ledger:tx:1' })).status,
    'applied',
  );
  assert.equal(
    await db.collection(COLLECTIONS.deadLetterEvents).findOne({ _id: 'ledger:tx:1' }),
    null,
    'successful replay clears dead-letter state',
  );
});
