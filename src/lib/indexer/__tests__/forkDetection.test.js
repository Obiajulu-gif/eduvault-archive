import { describe, it, expect } from "vitest";
import { detectFork, rewindAfterFork } from "../forkDetection.js";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";

function createFakeDb() {
  const collections = new Map();

  function matches(doc, query) {
    return Object.entries(query).every(([k, v]) => {
      if (v && typeof v === "object" && "$gte" in v) return (doc?.[k] ?? -Infinity) >= v.$gte;
      if (v && typeof v === "object" && "$ne" in v) return doc?.[k] !== v.$ne;
      return doc?.[k] === v;
    });
  }

  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    const data = collections.get(name);
    return {
      async findOne(query = {}) {
        for (const doc of data.values()) if (matches(doc, query)) return doc;
        return null;
      },
      find(query = {}) {
        const results = Array.from(data.values()).filter((d) => matches(d, query));
        return { toArray: async () => results };
      },
      async updateOne(query, update) {
        for (const doc of data.values()) {
          if (matches(doc, query)) {
            if (update.$set) Object.assign(doc, update.$set);
            return { matchedCount: 1 };
          }
        }
        const doc = { ...query };
        if (update.$set) Object.assign(doc, update.$set);
        data.set(doc._id, doc);
        return { matchedCount: 0, upsertedCount: 1 };
      },
      async updateMany(query, update) {
        let modifiedCount = 0;
        for (const doc of data.values()) {
          if (matches(doc, query)) {
            if (update.$set) Object.assign(doc, update.$set);
            modifiedCount += 1;
          }
        }
        return { modifiedCount };
      },
      _seed(id, doc) {
        data.set(id, { _id: id, ...doc });
      },
      _all() {
        return Array.from(data.values());
      },
    };
  }

  return { collection };
}

describe("detectFork", () => {
  it("reports no fork when the canonical hash matches", async () => {
    const getLedgerHash = async () => ({ sequence: 100, hash: "abc" });
    const result = await detectFork(null, { ledger: 100, expectedHash: "abc", getLedgerHash });
    expect(result).toEqual({ forked: false });
  });

  it("reports a fork when the canonical hash differs", async () => {
    const getLedgerHash = async () => ({ sequence: 100, hash: "different" });
    const result = await detectFork(null, { ledger: 100, expectedHash: "abc", getLedgerHash });
    expect(result).toEqual({ forked: true, canonicalHash: "different" });
  });

  it("does not report a fork when the ledger has aged out of retention", async () => {
    const getLedgerHash = async () => null;
    const result = await detectFork(null, { ledger: 5, expectedHash: "abc", getLedgerHash });
    expect(result).toEqual({ forked: false });
  });

  it("is a no-op when no getLedgerHash function is supplied", async () => {
    const result = await detectFork(null, { ledger: 100, expectedHash: "abc" });
    expect(result).toEqual({ forked: false });
  });
});

describe("rewindAfterFork", () => {
  it("orphans materials and purchases at or after the divergence ledger, and rewinds the cursor", async () => {
    const db = createFakeDb();
    db.collection(COLLECTIONS.materials)._seed("m1", { chainLedger: 100, syncStatus: "indexed" });
    db.collection(COLLECTIONS.materials)._seed("m2", { chainLedger: 50, syncStatus: "indexed" });
    db.collection(COLLECTIONS.purchases)._seed("p1", {
      indexedLedger: 100,
      buyerAddress: "gbuyer",
      materialId: "m1",
      settlementState: "Pending",
    });
    db.collection(COLLECTIONS.syncState)._seed("stellar:events", { cursor: "c", lastLedger: 100, lastLedgerHash: "abc" });

    const result = await rewindAfterFork(db, { source: "stellar", divergenceLedger: 90 });

    expect(result).toEqual({ orphanedMaterials: 1, orphanedPurchases: 1 });
    expect(db.collection(COLLECTIONS.materials)._all().find((m) => m._id === "m1").syncStatus).toBe("orphaned");
    expect(db.collection(COLLECTIONS.materials)._all().find((m) => m._id === "m2").syncStatus).toBe("indexed");
    expect(db.collection(COLLECTIONS.purchases)._all().find((p) => p._id === "p1").settlementState).toBe("Orphaned");

    const state = db.collection(COLLECTIONS.syncState)._all().find((s) => s._id === "stellar:events");
    expect(state.cursor).toBeNull();
    expect(state.lastLedger).toBeNull();
    expect(state.lastLedgerHash).toBeNull();
    expect(state.lastForkDivergenceLedger).toBe(90);
  });
});
