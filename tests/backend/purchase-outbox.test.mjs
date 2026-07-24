import assert from "node:assert/strict";
import { test, describe, before, after, beforeEach } from "node:test";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import * as dotenv from "dotenv";

// For tests, load .env.local if present, else .env
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { insertOutboxEvent, pollOutbox, completeOutboxEvent, failOutboxEvent, OUTBOX_STATUS, OUTBOX_EVENT_TYPES } from "../../src/lib/outbox.js";
import { processOutboxEvents } from "../../src/lib/backend/outboxWorker.js";
import { closeMongoConnection } from "../../src/lib/mongodb.js";
import { PURCHASE_STATES, canTransition } from "../../src/lib/purchases/stateMachine.js";


const TEST_DB = "eduvault_test_outbox";

let mongoServer;
let client;
let db;
let dbAvailable = false;

describe("Purchase Outbox & State Machine", () => {
  before(async () => {
    try {
      mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      const uri = mongoServer.getUri();
      // Override env var so outboxWorker uses the in-memory db
      process.env.MONGODB_URI = uri;
      process.env.MONGODB_DB = TEST_DB;

      client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
      await client.connect();
      db = client.db(TEST_DB);
      dbAvailable = true;
    } catch (err) {
      console.warn("[WARN] Skipping purchase-outbox tests: MongoDB not available. Details: " + err.message);
      dbAvailable = false;
    }
  });

  after(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (client) await client.close();
    await closeMongoConnection();
    if (mongoServer) await mongoServer.stop();
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    await db.collection("outbox").deleteMany({});
    await db.collection("purchases").deleteMany({});
    await db.collection("entitlement_cache").deleteMany({});
  });

  test("State machine transitions", () => {
    assert.strictEqual(canTransition(PURCHASE_STATES.PENDING, PURCHASE_STATES.CONFIRMED), true);
    assert.strictEqual(canTransition(PURCHASE_STATES.CONFIRMED, PURCHASE_STATES.PENDING), false);
  });

  test("Outbox insertion and polling", async (t) => { if (!dbAvailable) return t.skip("MongoDB not available");
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await insertOutboxEvent(db, session, {
          type: OUTBOX_EVENT_TYPES.SEND_PURCHASE_WEBHOOK,
          payload: { materialId: "m1", buyerAddress: "addr1" },
          idempotencyKey: "test1",
        });
      });
    } finally {
      await session.endSession();
    }

    const events = await pollOutbox(db, 5, 5000); // 5s lease
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, OUTBOX_EVENT_TYPES.SEND_PURCHASE_WEBHOOK);
    assert.ok(events[0].lockedUntil instanceof Date);

    // Concurrency / lease test: Polling again should yield 0 since it's leased
    const events2 = await pollOutbox(db, 5, 5000);
    assert.strictEqual(events2.length, 0);

    // Complete the event
    await completeOutboxEvent(db, events[0]._id);
    const completedEvent = await db.collection("outbox").findOne({ _id: events[0]._id });
    assert.strictEqual(completedEvent.status, OUTBOX_STATUS.COMPLETED);
    assert.strictEqual(completedEvent.lockedUntil, null);
  });

  test("Transient and permanent downstream failures with dead-lettering", async (t) => { if (!dbAvailable) return t.skip("MongoDB not available");
    await insertOutboxEvent(db, null, {
      type: OUTBOX_EVENT_TYPES.SEND_PURCHASE_WEBHOOK,
      payload: { materialId: "m2" },
      idempotencyKey: "test2",
    });

    let events = await pollOutbox(db, 1, 100);
    assert.strictEqual(events.length, 1);
    
    // Fail it transiently
    await failOutboxEvent(db, events[0]._id, "Transient network error", 3);
    let failedEvent = await db.collection("outbox").findOne({ _id: events[0]._id });
    assert.strictEqual(failedEvent.status, OUTBOX_STATUS.PENDING);
    assert.strictEqual(failedEvent.retries, 1);
    assert.ok(failedEvent.lockedUntil instanceof Date); // Set for backoff delay

    // Fast-forward lockedUntil for testing
    await db.collection("outbox").updateOne({ _id: events[0]._id }, { $set: { lockedUntil: null } });

    events = await pollOutbox(db, 1, 100);
    assert.strictEqual(events.length, 1);

    // Fail 2nd time
    await failOutboxEvent(db, events[0]._id, "Transient network error", 3);
    
    await db.collection("outbox").updateOne({ _id: events[0]._id }, { $set: { lockedUntil: null } });
    events = await pollOutbox(db, 1, 100);

    // Fail 3rd time - should dead letter
    await failOutboxEvent(db, events[0]._id, "Permanent error", 3);
    failedEvent = await db.collection("outbox").findOne({ _id: events[0]._id });
    assert.strictEqual(failedEvent.status, OUTBOX_STATUS.DEAD_LETTER);
    assert.strictEqual(failedEvent.lockedUntil, null);

    // Should not be pollable anymore
    events = await pollOutbox(db, 1, 100);
    assert.strictEqual(events.length, 0);
  });

  test("Worker execution processes events and handles mock failures", async (t) => { if (!dbAvailable) return t.skip("MongoDB not available");
    let calls = 0;
    const mockBroadcast = async (materialId, payload) => {
      calls++;
      if (payload.shouldFail) throw new Error("Mock failure");
      return true;
    };

    await insertOutboxEvent(db, null, {
      type: OUTBOX_EVENT_TYPES.SEND_PURCHASE_WEBHOOK,
      payload: { materialId: "m3", shouldFail: false },
      idempotencyKey: "worker_test1",
    });

    await insertOutboxEvent(db, null, {
      type: OUTBOX_EVENT_TYPES.SEND_PURCHASE_WEBHOOK,
      payload: { materialId: "m4", shouldFail: true },
      idempotencyKey: "worker_test2",
    });

    const processed = await processOutboxEvents(mockBroadcast);
    assert.strictEqual(processed, 2);
    assert.strictEqual(calls, 2);

    const successfulEvent = await db.collection("outbox").findOne({ idempotencyKey: "worker_test1" });
    assert.strictEqual(successfulEvent.status, OUTBOX_STATUS.COMPLETED);

    const failingEvent = await db.collection("outbox").findOne({ idempotencyKey: "worker_test2" });
    assert.strictEqual(failingEvent.status, OUTBOX_STATUS.PENDING);
    assert.strictEqual(failingEvent.retries, 1);
  });
});
