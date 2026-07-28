import { describe, it, expect, vi, beforeEach } from "vitest";
import { xdr, nativeToScVal, Address, Keypair } from "@stellar/stellar-sdk";

vi.mock("@/lib/email", () => ({ sendReceiptIfEligible: vi.fn().mockResolvedValue(undefined) }));

import { runIndexerBatch, classifyIndexerError } from "../stellarIndexer.js";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";

function toBase64(scVal) {
  return scVal.toXDR("base64");
}
function symbolTopic(name) {
  return toBase64(nativeToScVal(name, { type: "symbol" }));
}
function u64Topic(value) {
  return toBase64(nativeToScVal(BigInt(value), { type: "u64" }));
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

function purchaseCompletedRawEvent({ id, purchaseId, materialId, buyer, seller, asset, amount }) {
  return {
    id,
    ledger: 100,
    txHash: `tx-${id}`,
    ledgerClosedAt: "2026-07-25T00:00:00Z",
    topic: [
      symbolTopic("purchase"),
      symbolTopic("completed"),
      u64Topic(purchaseId),
      bytesTopic(materialId),
      addressTopic(buyer),
    ],
    value: vecValue([
      new Address(seller).toScVal(),
      new Address(asset).toScVal(),
      nativeToScVal(BigInt(amount), { type: "i128" }),
      nativeToScVal(0n, { type: "i128" }),
      nativeToScVal(BigInt(amount), { type: "i128" }),
      xdr.ScVal.scvBool(true),
      nativeToScVal(Buffer.alloc(16, 1), { type: "bytes" }),
    ]),
  };
}

// Minimal in-memory Mongo-like fake covering exactly the operations
// runIndexerBatch/applyIndexedEvent perform.
function createFakeDb() {
  const collections = new Map();
  let autoId = 0;

  function matches(doc, query) {
    return Object.entries(query).every(([k, v]) => doc?.[k] === v);
  }

  function applyUpdate(doc, update, isInsert) {
    if (update.$set) Object.assign(doc, update.$set);
    if (isInsert && update.$setOnInsert) {
      for (const [k, v] of Object.entries(update.$setOnInsert)) {
        if (!(k in doc)) doc[k] = v;
      }
    }
  }

  const collectionObjects = new Map();

  function collection(name) {
    if (collectionObjects.has(name)) return collectionObjects.get(name);

    if (!collections.has(name)) collections.set(name, new Map());
    const data = collections.get(name);

    const obj = {
      async insertOne(doc) {
        if (data.has(doc._id)) {
          const err = new Error("E11000 duplicate key error");
          err.code = 11000;
          throw err;
        }
        data.set(doc._id, { ...doc });
        return { insertedId: doc._id };
      },
      async findOne(query = {}) {
        for (const doc of data.values()) {
          if (matches(doc, query)) return doc;
        }
        return null;
      },
      find(query = {}) {
        const results = Array.from(data.values()).filter((d) => matches(d, query));
        return { toArray: async () => results };
      },
      async updateOne(query, update, opts = {}) {
        for (const doc of data.values()) {
          if (matches(doc, query)) {
            applyUpdate(doc, update, false);
            return { matchedCount: 1, upsertedCount: 0 };
          }
        }
        if (opts.upsert) {
          const id = query._id ?? `auto-${++autoId}`;
          const doc = { ...query, _id: id };
          applyUpdate(doc, update, true);
          data.set(id, doc);
          return { matchedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, upsertedCount: 0 };
      },
      async deleteOne(query) {
        for (const [key, doc] of data.entries()) {
          if (matches(doc, query)) {
            data.delete(key);
            return { deletedCount: 1 };
          }
        }
        return { deletedCount: 0 };
      },
      _all() {
        return Array.from(data.values());
      },
    };

    collectionObjects.set(name, obj);
    return obj;
  }

  return { collection };
}

beforeEach(() => vi.clearAllMocks());

describe("runIndexerBatch", () => {
  it("parses and applies a valid on-chain purchase.completed event", async () => {
    const db = createFakeDb();
    const buyer = Keypair.random().publicKey();
    const seller = Keypair.random().publicKey();
    const asset = Keypair.random().publicKey();
    const materialId = Buffer.alloc(32, 5);

    const rawEvent = purchaseCompletedRawEvent({
      id: "evt-1",
      purchaseId: 1,
      materialId,
      buyer,
      seller,
      asset,
      amount: 1_000_000,
    });

    const eventSource = {
      getEvents: vi.fn().mockResolvedValue({ events: [rawEvent], nextCursor: "cursor-1", lastLedger: 100 }),
    };

    const result = await runIndexerBatch({ db, eventSource });

    expect(result).toEqual({ applied: 1, skipped: 0, nextCursor: "cursor-1", hadFailure: false });

    const purchases = db.collection(COLLECTIONS.purchases)._all();
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({
      materialId: materialId.toString("hex"),
      buyerAddress: buyer.toLowerCase(),
      sellerAddress: seller,
      amount: "1000000",
      status: "settled",
    });

    const entitlements = db.collection(COLLECTIONS.entitlementCache)._all();
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0].active).toBe(true);
  });

  it("skips events with an unrecognized topic without touching the dead-letter collection", async () => {
    const db = createFakeDb();
    const unknownEvent = {
      id: "evt-unknown",
      ledger: 1,
      txHash: "tx-unknown",
      topic: [symbolTopic("some_other"), symbolTopic("thing")],
      value: vecValue([]),
    };

    const eventSource = {
      getEvents: vi.fn().mockResolvedValue({ events: [unknownEvent], nextCursor: null, lastLedger: 1 }),
    };

    const result = await runIndexerBatch({ db, eventSource });

    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(db.collection(COLLECTIONS.deadLetterEvents)._all()).toHaveLength(0);
    expect(db.collection(COLLECTIONS.syncEvents)._all()).toHaveLength(0);
  });

  it("prevents duplicate purchase rows across two batches for the same event id", async () => {
    const db = createFakeDb();
    const buyer = Keypair.random().publicKey();
    const seller = Keypair.random().publicKey();
    const asset = Keypair.random().publicKey();
    const materialId = Buffer.alloc(32, 9);

    const rawEvent = purchaseCompletedRawEvent({
      id: "evt-dup",
      purchaseId: 2,
      materialId,
      buyer,
      seller,
      asset,
      amount: 2_000_000,
    });

    const eventSource = {
      getEvents: vi.fn().mockResolvedValue({ events: [rawEvent], nextCursor: "c", lastLedger: 1 }),
    };

    const first = await runIndexerBatch({ db, eventSource });
    const second = await runIndexerBatch({ db, eventSource });

    expect(first).toEqual({ applied: 1, skipped: 0, nextCursor: "c", hadFailure: false });
    expect(second).toEqual({ applied: 0, skipped: 1, nextCursor: "c", hadFailure: false });
    expect(db.collection(COLLECTIONS.purchases)._all()).toHaveLength(1);
  });

  it("does not advance the checkpoint cursor past a failed event (#469)", async () => {
    const db = createFakeDb();
    // Make the purchases collection's updateOne throw on every call, so the
    // event fails to apply.
    const purchasesCol = db.collection(COLLECTIONS.purchases);
    purchasesCol.updateOne = async () => {
      const err = new Error("simulated failure");
      throw err;
    };

    const buyer = Keypair.random().publicKey();
    const seller = Keypair.random().publicKey();
    const asset = Keypair.random().publicKey();
    const materialId = Buffer.alloc(32, 3);
    const rawEvent = purchaseCompletedRawEvent({
      id: "evt-fail",
      purchaseId: 3,
      materialId,
      buyer,
      seller,
      asset,
      amount: 500_000,
    });

    const eventSource = {
      getEvents: vi.fn().mockResolvedValue({ events: [rawEvent], nextCursor: "should-not-be-used", lastLedger: 200 }),
    };

    const result = await runIndexerBatch({ db, eventSource });

    expect(result.hadFailure).toBe(true);
    expect(result.applied).toBe(0);
    // The cursor must not jump to the RPC's `nextCursor` when a failure
    // occurred, since that would skip past the failed event forever.
    expect(result.nextCursor).not.toBe("should-not-be-used");

    // A generic error with no recognizable transient shape classifies as
    // poison, which is marked failed immediately rather than retried.
    const dl = await db.collection(COLLECTIONS.deadLetterEvents).findOne({});
    expect(dl).toBeTruthy();
    expect(dl.status).toBe("failed");
    expect(dl.errorClass).toBe("poison");
  });
});

describe("classifyIndexerError", () => {
  it("classifies network-shaped errors as transient", () => {
    expect(classifyIndexerError({ code: "ECONNRESET" })).toBe("transient");
    expect(classifyIndexerError({ code: "ETIMEDOUT" })).toBe("transient");
    expect(classifyIndexerError({ message: "request timeout" })).toBe("transient");
  });

  it("classifies 5xx and 429 status-shaped errors as transient", () => {
    expect(classifyIndexerError({ code: 500 })).toBe("transient");
    expect(classifyIndexerError({ response: { status: 503 } })).toBe("transient");
    expect(classifyIndexerError({ status: 429 })).toBe("transient");
  });

  it("classifies everything else as poison", () => {
    expect(classifyIndexerError(new Error("Indexed event is missing a stable id"))).toBe("poison");
    expect(classifyIndexerError({ code: "SOME_VALIDATION_ERROR" })).toBe("poison");
  });
});
