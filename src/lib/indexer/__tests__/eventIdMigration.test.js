import { describe, it, expect } from "vitest";
import { migrateEventIds } from "../eventIdMigration.js";
import { deriveEventIdFromEvent } from "../eventIdentity.js";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";

const NET = "Public Global Stellar Network ; September 2015";

// Minimal in-memory Mongo-like fake — just what migrateEventIds touches.
function createFakeDb(seed = {}) {
  const collections = new Map();
  const cache = new Map();
  const matches = (doc, q) => Object.entries(q).every(([k, v]) => doc?.[k] === v);
  function collection(name) {
    if (cache.has(name)) return cache.get(name);
    if (!collections.has(name)) collections.set(name, new Map());
    const data = collections.get(name);
    const obj = {
      async insertOne(doc) {
        if (data.has(doc._id)) { const e = new Error("dup"); e.code = 11000; throw e; }
        data.set(doc._id, { ...doc });
        return { insertedId: doc._id };
      },
      async findOne(q = {}) { for (const d of data.values()) if (matches(d, q)) return d; return null; },
      find() {
        const arr = [...data.values()];
        return { [Symbol.asyncIterator]() { let i = 0; return { next: async () => (i < arr.length ? { value: arr[i++], done: false } : { value: undefined, done: true }) }; } };
      },
      async updateOne(q, update, opts = {}) {
        for (const d of data.values()) if (matches(d, q)) { if (update.$set) Object.assign(d, update.$set); return { matchedCount: 1 }; }
        if (opts.upsert) {
          const d = { ...q, _id: q._id };
          if (update.$setOnInsert) Object.assign(d, update.$setOnInsert);
          if (update.$set) Object.assign(d, update.$set);
          data.set(d._id, d);
          return { upsertedCount: 1 };
        }
        return { matchedCount: 0 };
      },
      async deleteOne(q) { for (const [k, d] of data.entries()) if (matches(d, q)) { data.delete(k); return { deletedCount: 1 }; } return { deletedCount: 0 }; },
      _all() { return [...data.values()]; },
    };
    cache.set(name, obj);
    return obj;
  }
  for (const [name, docs] of Object.entries(seed)) {
    const c = collection(name);
    for (const d of docs) c._all(), collections.get(name).set(d._id, { ...d });
  }
  return { collection };
}

function rpcRaw(overrides = {}) {
  return {
    id: overrides.id ?? "0016010972359577600-0000000001",
    ledger: 3727254,
    txHash: "b7d3f2c1a09e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4",
    operationIndex: 0,
    contractId: "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
    type: "purchase.completed",
    ...overrides,
  };
}
const canonicalOf = (raw) => deriveEventIdFromEvent({ ...raw, network: NET }).id;

describe("migrateEventIds", () => {
  it("rewrites a legacy bare-Soroban-id sync_events row to its canonical id", async () => {
    const raw = rpcRaw();
    const db = createFakeDb({ [COLLECTIONS.syncEvents]: [{ _id: raw.id, raw, createdAt: new Date("2026-01-01") }] });

    const report = await migrateEventIds(db, { apply: true, network: NET });

    expect(report.totals).toMatchObject({ scanned: 1, unchanged: 0, rewritten: 1, collisions: 0, quarantined: 0 });
    const rows = db.collection(COLLECTIONS.syncEvents)._all();
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(canonicalOf(raw));
    expect(rows[0].createdAt).toEqual(new Date("2026-01-01")); // preserved
    expect(rows[0].migratedFrom).toBe(raw.id);
  });

  it("is idempotent — a second run reports all-unchanged and writes nothing", async () => {
    const raw = rpcRaw();
    const db = createFakeDb({ [COLLECTIONS.syncEvents]: [{ _id: raw.id, raw, createdAt: new Date("2026-01-01") }] });

    await migrateEventIds(db, { apply: true, network: NET });
    const second = await migrateEventIds(db, { apply: true, network: NET });

    expect(second.totals).toMatchObject({ scanned: 1, unchanged: 1, rewritten: 0, collisions: 0, quarantined: 0 });
    expect(db.collection(COLLECTIONS.syncEvents)._all()).toHaveLength(1);
  });

  it("dry run makes no writes", async () => {
    const raw = rpcRaw();
    const db = createFakeDb({ [COLLECTIONS.syncEvents]: [{ _id: raw.id, raw, createdAt: new Date() }] });

    const report = await migrateEventIds(db, { apply: false, network: NET });

    expect(report.dryRun).toBe(true);
    expect(report.totals.rewritten).toBe(1);
    expect(db.collection(COLLECTIONS.syncEvents)._all()[0]._id).toBe(raw.id); // untouched
  });

  it("reports a collision when two rows canonicalise to one id, keeping the earlier createdAt", async () => {
    const raw = rpcRaw();
    const canonical = canonicalOf(raw);
    const db = createFakeDb({
      [COLLECTIONS.syncEvents]: [
        { _id: raw.id, raw, createdAt: new Date("2026-02-01") }, // legacy id, later
        { _id: canonical, raw, createdAt: new Date("2026-01-01") }, // already canonical, earlier
      ],
    });

    const report = await migrateEventIds(db, { apply: true, network: NET });

    expect(report.totals).toMatchObject({ scanned: 2, unchanged: 1, rewritten: 0, collisions: 1 });
    const collision = report.collections[COLLECTIONS.syncEvents].collisions[0];
    expect(collision.canonicalId).toBe(canonical);
    expect(collision.keptId).toBe(canonical);
    expect(collision.droppedId).toBe(raw.id);
    // The later, legacy-id row is gone; the earlier canonical row remains.
    const rows = db.collection(COLLECTIONS.syncEvents)._all();
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(canonical);
    expect(rows[0].createdAt).toEqual(new Date("2026-01-01"));
  });

  it("quarantines a row whose raw event has no identifiable position", async () => {
    const db = createFakeDb({
      [COLLECTIONS.deadLetterEvents]: [
        { _id: "stellar:unknown:1:abc", raw: { ledger: 1, txHash: "t", operationIndex: 0 }, source: "stellar", createdAt: new Date() },
      ],
    });

    const report = await migrateEventIds(db, { apply: true, network: NET });

    expect(report.totals).toMatchObject({ scanned: 1, unchanged: 0, rewritten: 0, quarantined: 1 });
    expect(db.collection(COLLECTIONS.deadLetterEvents)._all()).toHaveLength(0);
    const q = db.collection(COLLECTIONS.indexerQuarantine)._all();
    expect(q).toHaveLength(1);
    expect(q[0].migratedFrom).toEqual({ collection: COLLECTIONS.deadLetterEvents, _id: "stellar:unknown:1:abc" });
    expect(q[0].status).toBe("pending");
  });

  it("re-keys dead_letter_events rows using the stored parsed event", async () => {
    const parsed = { id: "0016010972359577600-0000000009", ledger: 5, transactionHash: "h", operationIndex: 2, contractId: "C", type: "purchase.refunded" };
    const db = createFakeDb({
      [COLLECTIONS.deadLetterEvents]: [{ _id: parsed.id, raw: { ...parsed, txHash: "h" }, parsed, source: "stellar", createdAt: new Date("2026-03-03") }],
    });

    const report = await migrateEventIds(db, { collections: ["dead_letter_events"], apply: true, network: NET });

    expect(report.totals).toMatchObject({ scanned: 1, rewritten: 1 });
    const rows = db.collection(COLLECTIONS.deadLetterEvents)._all();
    expect(rows[0]._id).toBe(deriveEventIdFromEvent({ ...parsed, network: NET }).id);
  });
});
