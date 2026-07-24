import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import {
  applyIndexedEvent,
  deadLetterId,
  reprocessDeadLetters,
  runIndexerBatch,
} from "../../src/lib/indexer/stellarIndexer.js";
import { createFakeDb } from "./helpers/fakeMongo.mjs";

const COLLECTIONS = {
  purchases: "purchases",
  entitlements: "entitlement_cache",
  syncEvents: "sync_events",
  syncState: "sync_state",
  deadLetters: "dead_letter_events",
};

function purchaseEvent(overrides = {}) {
  return {
    type: "purchase.completed",
    network: "testnet",
    contractId: "CPURCHASE",
    ledger: 100,
    transactionHash: "tx-1",
    index: 0,
    materialId: "material-1",
    buyerAddress: "GBUYER",
    ...overrides,
  };
}

/** An event source that hands out one fixed page then reports itself drained. */
function pageSource(events, { tipLedger = 100, nextCursor = "cursor-1" } = {}) {
  let served = false;
  return {
    async getEvents() {
      if (served) return { events: [], nextCursor, lastLedger: tipLedger };
      served = true;
      return { events, nextCursor, lastLedger: tipLedger };
    },
  };
}

describe("event replay", () => {
  test("re-applying an event is a no-op that leaves one purchase and one entitlement", async () => {
    const db = createFakeDb();
    const event = purchaseEvent();

    const first = await applyIndexedEvent(db, event);
    const second = await applyIndexedEvent(db, event);
    const third = await applyIndexedEvent(db, event);

    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    assert.equal(third.skipped, true);

    assert.equal(db.dump(COLLECTIONS.purchases).length, 1);
    assert.equal(db.dump(COLLECTIONS.entitlements).length, 1);
    assert.equal(db.dump(COLLECTIONS.syncEvents).length, 1);
  });

  test("replaying a settled event retires its dead-letter instead of failing it", async () => {
    // Regression: the skip branch used to increment retryCount and flip the
    // row to `failed` once past INDEXER_MAX_RETRIES, so a healthy replay drove
    // its own dead-letter to a terminal state and the cleanup delete never ran
    // because it was gated on !skipped.
    const db = createFakeDb();
    const event = purchaseEvent();
    const id = deadLetterId(event, "stellar");

    await db.collection(COLLECTIONS.deadLetters).updateOne(
      { _id: id },
      { $set: { _id: id, raw: event, status: "retryable", retryCount: 3, source: "stellar" } },
      { upsert: true },
    );

    // First pass applies the event and clears the dead-letter.
    await runIndexerBatch({ db, eventSource: pageSource([event]) });
    assert.equal(await db.collection(COLLECTIONS.deadLetters).countDocuments({}), 0);

    // Re-deliver the same event; it is now a skip, and must stay retired.
    await db.collection(COLLECTIONS.deadLetters).updateOne(
      { _id: id },
      { $set: { _id: id, raw: event, status: "retryable", retryCount: 3, source: "stellar" } },
      { upsert: true },
    );
    const replay = await runIndexerBatch({ db, eventSource: pageSource([event]) });

    assert.equal(replay.skipped, 1);
    assert.equal(await db.collection(COLLECTIONS.deadLetters).countDocuments({}), 0);
  });
});

describe("checkpoint resume", () => {
  test("a batch that dies mid-apply resumes without losing or duplicating the event", async () => {
    const faults = [{ collection: COLLECTIONS.entitlements, operation: "updateOne", remaining: 1 }];
    const db = createFakeDb({ faults });
    const event = purchaseEvent();

    // Crash after the purchase projection but before the entitlement one.
    const crashed = await runIndexerBatch({ db, eventSource: pageSource([event]) });
    assert.equal(crashed.applied, 0);

    // The receipt is left mid-flight rather than applied, and the event is
    // durably parked for retry.
    const receipt = await db.collection(COLLECTIONS.syncEvents).findOne({});
    assert.notEqual(receipt.status, "applied");
    assert.equal(await db.collection(COLLECTIONS.deadLetters).countDocuments({}), 1);

    // Restart: the fault is spent, so the retry completes the projection.
    db.clearFaults();
    const resumed = await reprocessDeadLetters(db);

    assert.equal(resumed.reprocessed.length, 1);
    assert.equal(db.dump(COLLECTIONS.purchases).length, 1);
    assert.equal(db.dump(COLLECTIONS.entitlements).length, 1);
    assert.equal((await db.collection(COLLECTIONS.syncEvents).findOne({})).status, "applied");
  });

  test("the cursor written by one batch is the cursor the next batch reads", async () => {
    const db = createFakeDb();
    let observedCursor = "unset";

    await runIndexerBatch({
      db,
      eventSource: {
        async getEvents({ cursor }) {
          observedCursor = cursor;
          return { events: [], nextCursor: "cursor-42", lastLedger: 500 };
        },
      },
    });

    assert.equal(observedCursor, null, "first run starts from no cursor");
    assert.equal(
      (await db.collection(COLLECTIONS.syncState).findOne({ _id: "stellar:events" })).cursor,
      "cursor-42",
    );

    await runIndexerBatch({
      db,
      eventSource: {
        async getEvents({ cursor }) {
          observedCursor = cursor;
          return { events: [], nextCursor: "cursor-43", lastLedger: 500 };
        },
      },
    });

    assert.equal(observedCursor, "cursor-42", "second run resumes from the stored checkpoint");
  });
});

describe("dead-letter accounting", () => {
  test("an unidentifiable event yields one stable row rather than one per attempt", async () => {
    // eventId() returns "" for an event with no id and no ledger/tx/position,
    // and the old code fell back to Math.random(), so every failed attempt
    // wrote a fresh row and retryCount never reached the ceiling.
    const malformed = { type: "purchase.completed", materialId: "m", buyerAddress: "GB" };
    const db = createFakeDb();

    await runIndexerBatch({ db, eventSource: pageSource([malformed]) });
    await runIndexerBatch({ db, eventSource: pageSource([malformed]) });
    await runIndexerBatch({ db, eventSource: pageSource([malformed]) });

    assert.equal(await db.collection(COLLECTIONS.deadLetters).countDocuments({}), 1);
    assert.equal(deadLetterId(malformed, "stellar"), deadLetterId(malformed, "stellar"));
  });

  test("reprocess leaves terminal rows alone and retires them once exhausted", async () => {
    const db = createFakeDb();
    const poison = purchaseEvent({ transactionHash: "tx-poison" });
    const id = deadLetterId(poison, "stellar");

    await db.collection(COLLECTIONS.deadLetters).updateOne(
      { _id: id },
      { $set: { _id: id, raw: poison, status: "failed", retryCount: 99, source: "stellar" } },
      { upsert: true },
    );

    // Default statuses no longer include `failed`, so a terminal row is not
    // swept back in on every pass.
    const result = await reprocessDeadLetters(db);
    assert.equal(result.reprocessed.length, 0);
    assert.equal((await db.collection(COLLECTIONS.deadLetters).findOne({ _id: id })).retryCount, 99);

    // Operators can still opt in explicitly.
    const forced = await reprocessDeadLetters(db, { statuses: ["retryable", "failed"] });
    assert.equal(forced.reprocessed.length, 1);
  });
});

describe("ledger lag", () => {
  beforeEach(() => {});

  test("a short page means caught up, so lag is zero", async () => {
    const db = createFakeDb();
    const result = await runIndexerBatch({
      db,
      eventSource: pageSource([purchaseEvent({ ledger: 90 })], { tipLedger: 1000 }),
      limit: 100,
    });

    assert.equal(result.drained, true);
    assert.equal(result.ledgerLag, 0);
  });

  test("a full page reports the distance from the tip to the newest applied event", async () => {
    const db = createFakeDb();
    const events = Array.from({ length: 2 }, (_, i) =>
      purchaseEvent({ ledger: 900 + i, transactionHash: `tx-${i}`, materialId: `material-${i}` }),
    );

    const result = await runIndexerBatch({
      db,
      eventSource: pageSource(events, { tipLedger: 1000 }),
      limit: 2, // a full page: events.length === limit
    });

    assert.equal(result.drained, false);
    assert.equal(result.ledgerLag, 1000 - 901);

    const state = await db.collection(COLLECTIONS.syncState).findOne({ _id: "stellar:events" });
    assert.equal(state.lastProcessedLedger, 901);
    assert.equal(state.lastLedger, 1000);
  });
});
