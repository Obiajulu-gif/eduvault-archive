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

describe("detectFork (deep reorgs)", () => {
  const checkpoints = [
    { ledger: 90, hash: "h90" },
    { ledger: 100, hash: "h100" },
    { ledger: 110, hash: "h110" },
  ];

  it("reports no fork when the most recent checkpoint still matches", async () => {
    const canonical = { 90: "h90", 100: "h100", 110: "h110" };
    const result = await detectFork(null, {
      checkpoints,
      getLedgerHash: async (l) => ({ sequence: l, hash: canonical[l] }),
    });
    expect(result).toEqual({ forked: false });
  });

  it("identifies the true divergence ledger for a one-checkpoint-deep reorg", async () => {
    const canonical = { 90: "h90", 100: "h100", 110: "other" };
    const result = await detectFork(null, {
      checkpoints,
      getLedgerHash: async (l) => ({ sequence: l, hash: canonical[l] }),
    });
    expect(result).toEqual({ forked: true, divergenceLedger: 101, canonicalHash: "other" });
  });

  it("walks back multiple checkpoints for a deep reorg", async () => {
    // 110 and 100 both diverged; 90 still matches canonical.
    const canonical = { 90: "h90", 100: "other2", 110: "other1" };
    const result = await detectFork(null, {
      checkpoints,
      getLedgerHash: async (l) => ({ sequence: l, hash: canonical[l] }),
    });
    expect(result).toEqual({ forked: true, divergenceLedger: 91, canonicalHash: "other2" });
  });

  it("reports divergence at the oldest retained checkpoint when nothing matches", async () => {
    const result = await detectFork(null, {
      checkpoints,
      getLedgerHash: async () => ({ sequence: 0, hash: "different" }),
    });
    expect(result).toEqual({ forked: true, divergenceLedger: 90, canonicalHash: "different" });
  });

  it("skips checkpoints that aged out of retention while walking back", async () => {
    // 110 aged out (unverifiable); 100 mismatches; 90 still matches.
    const canonical = { 90: "h90", 100: "other" };
    const result = await detectFork(null, {
      checkpoints,
      getLedgerHash: async (l) => (canonical[l] ? { sequence: l, hash: canonical[l] } : null),
    });
    expect(result).toEqual({ forked: true, divergenceLedger: 91, canonicalHash: "other" });
  });

  it("does not declare a fork when only unverifiable checkpoints precede a match", async () => {
    // 110 aged out; 100 matches canonical — no observed mismatch, so no fork.
    const canonical = { 100: "h100" };
    const result = await detectFork(null, {
      checkpoints,
      getLedgerHash: async (l) => (canonical[l] ? { sequence: l, hash: canonical[l] } : null),
    });
    expect(result).toEqual({ forked: false });
  });

  it("reports no fork when every checkpoint aged out of retention", async () => {
    const result = await detectFork(null, {
      checkpoints,
      getLedgerHash: async () => null,
    });
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

  it("retains checkpoints below the divergence point and drops the rest", async () => {
    const db = createFakeDb();
    db.collection(COLLECTIONS.syncState)._seed("stellar:events", {
      cursor: "c",
      lastLedger: 110,
      lastLedgerHash: "h110",
      checkpoints: [
        { ledger: 90, hash: "h90" },
        { ledger: 100, hash: "h100" },
        { ledger: 110, hash: "h110" },
      ],
    });

    await rewindAfterFork(db, { source: "stellar", divergenceLedger: 101 });

    const state = db.collection(COLLECTIONS.syncState)._all().find((s) => s._id === "stellar:events");
    expect(state.checkpoints).toEqual([
      { ledger: 90, hash: "h90" },
      { ledger: 100, hash: "h100" },
    ]);
  });
});
