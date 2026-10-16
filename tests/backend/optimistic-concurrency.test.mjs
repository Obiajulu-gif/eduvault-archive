import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { validateExpectedVersion, validateMaterialUpdatePayload } from "../../src/lib/api/validation.js";
import { createCheckoutQuote, consumeCheckoutQuote } from "../../src/lib/checkout/quotes.js";

function createMockMaterialsCollection(initialDocs = []) {
  const docs = JSON.parse(JSON.stringify(initialDocs));

  return {
    async findOne(filter) {
      return docs.find(doc => {
        return Object.entries(filter).every(([k, v]) => {
          if (k === "_id" || k === "materialId") {
            return String(doc._id || doc.materialId) === String(v);
          }
          if (k === "$or") {
            return v.some(subFilter => {
              if (subFilter.version && subFilter.version.$exists === false) {
                return doc.version === undefined || doc.version === null;
              }
              return doc.version === subFilter.version;
            });
          }
          return doc[k] === v;
        });
      }) || null;
    },

    async findOneAndUpdate(filter, update, options = {}) {
      const idx = docs.findIndex(doc => {
        return Object.entries(filter).every(([k, v]) => {
          if (k === "_id" || k === "materialId") {
            return String(doc._id || doc.materialId) === String(v);
          }
          if (k === "$or") {
            return v.some(subFilter => {
              if (subFilter.version && subFilter.version.$exists === false) {
                return doc.version === undefined || doc.version === null;
              }
              return doc.version === subFilter.version;
            });
          }
          return doc[k] === v;
        });
      });

      if (idx === -1) {
        return null;
      }

      const existing = docs[idx];
      if (update.$set) {
        docs[idx] = { ...existing, ...update.$set };
      }
      return options.returnDocument === "after" ? docs[idx] : existing;
    },

    async insertOne(doc) {
      docs.push({ ...doc, _id: doc._id || `mat-${Date.now()}` });
      return { insertedId: docs[docs.length - 1]._id };
    },

    _getAll() {
      return docs;
    }
  };
}

function createMockDb({ materials = [], quotes = [] } = {}) {
  const quoteDocs = JSON.parse(JSON.stringify(quotes));
  const materialsColl = createMockMaterialsCollection(materials);

  const quotesColl = {
    async findOne(filter) {
      return quoteDocs.find(q => {
        return Object.entries(filter).every(([k, v]) => {
          if (k === "expiresAt" && v?.$gt) {
            return new Date(q.expiresAt) > v.$gt;
          }
          return String(q[k]) === String(v);
        });
      }) || null;
    },
    async insertOne(doc) {
      quoteDocs.push(doc);
      return { insertedId: doc.quoteId };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      const idx = quoteDocs.findIndex(q => {
        if (filter.quoteId && q.quoteId !== filter.quoteId) return false;
        if (filter.status && q.status !== filter.status) return false;
        if (filter.expiresAt?.$gt && new Date(q.expiresAt) <= filter.expiresAt.$gt) return false;
        return true;
      });
      if (idx === -1) return null;
      if (update.$set) {
        quoteDocs[idx] = { ...quoteDocs[idx], ...update.$set };
      }
      return options.returnDocument === "after" ? quoteDocs[idx] : quoteDocs[idx];
    }
  };

  return {
    collection(name) {
      if (name === "materials") return materialsColl;
      if (name === "checkout_quotes") return quotesColl;
      return createMockMaterialsCollection([]);
    }
  };
}

describe("Optimistic Concurrency Control (OCC) - Issue #745", () => {
  describe("Validation of expectedVersion", () => {
    test("accepts valid positive integer versions", () => {
      assert.equal(validateExpectedVersion(1), 1);
      assert.equal(validateExpectedVersion(42), 42);
      assert.equal(validateExpectedVersion("5"), 5);
      assert.equal(validateExpectedVersion(null), null);
      assert.equal(validateExpectedVersion(undefined), null);
      assert.equal(validateExpectedVersion(""), null);
    });

    test("rejects invalid versions", () => {
      assert.throws(() => validateExpectedVersion(0), /must be a positive integer/);
      assert.throws(() => validateExpectedVersion(-1), /must be a positive integer/);
      assert.throws(() => validateExpectedVersion(1.5), /must be a positive integer/);
      assert.throws(() => validateExpectedVersion("abc"), /must be a positive integer/);
    });
  });

  describe("Listing Update Concurrency & Version Advancement", () => {
    test("advances document version atomically on valid matching version", async () => {
      const db = createMockDb({
        materials: [
          {
            _id: "mat-100",
            title: "Advanced Biology",
            price: 25,
            version: 1,
            userAddress: "GCREATOR1",
            visibility: "public"
          }
        ]
      });

      const materialsColl = db.collection("materials");
      const existing = await materialsColl.findOne({ _id: "mat-100" });
      assert.equal(existing.version, 1);

      const expectedVersion = 1;
      const nextVersion = expectedVersion + 1;
      const updates = { price: 30, title: "Advanced Biology 2nd Ed" };

      const filter = {
        _id: "mat-100",
        $or: [
          { version: expectedVersion },
          ...(expectedVersion === 1 ? [{ version: { $exists: false } }] : [])
        ]
      };

      const updated = await materialsColl.findOneAndUpdate(
        filter,
        { $set: { ...updates, version: nextVersion, updatedAt: new Date() } },
        { returnDocument: "after" }
      );

      assert.ok(updated);
      assert.equal(updated.version, 2);
      assert.equal(updated.price, 30);
      assert.equal(updated.title, "Advanced Biology 2nd Ed");
    });

    test("rejects stale write when expectedVersion is behind current version", async () => {
      const db = createMockDb({
        materials: [
          {
            _id: "mat-200",
            title: "Linear Algebra",
            price: 15,
            version: 3, // Already bumped to v3 by another session
            userAddress: "GCREATOR1"
          }
        ]
      });

      const materialsColl = db.collection("materials");
      const staleExpectedVersion = 2; // Stale client submitting edit based on v2

      const filter = {
        _id: "mat-200",
        $or: [
          { version: staleExpectedVersion },
          ...(staleExpectedVersion === 1 ? [{ version: { $exists: false } }] : [])
        ]
      };

      const result = await materialsColl.findOneAndUpdate(
        filter,
        { $set: { price: 20, version: staleExpectedVersion + 1 } },
        { returnDocument: "after" }
      );

      // CAS failure: result is null because version in DB is 3, not 2
      assert.equal(result, null);

      // Verify the document in DB was not overwritten
      const unchanged = await materialsColl.findOne({ _id: "mat-200" });
      assert.equal(unchanged.version, 3);
      assert.equal(unchanged.price, 15);
    });

    test("simulates concurrent race: only first writer succeeds and second receives conflict", async () => {
      const db = createMockDb({
        materials: [
          {
            _id: "mat-race",
            title: "Calculus I",
            price: 10,
            version: 1,
            userAddress: "GCREATOR1"
          }
        ]
      });

      const materialsColl = db.collection("materials");

      // Both Tab A and Tab B read at version 1
      const tabAExpectedVersion = 1;
      const tabBExpectedVersion = 1;

      // Tab A submits update first
      const filterA = {
        _id: "mat-race",
        $or: [{ version: tabAExpectedVersion }, { version: { $exists: false } }]
      };
      const resultA = await materialsColl.findOneAndUpdate(
        filterA,
        { $set: { title: "Calculus I - Tab A Edit", version: 2, updatedAt: new Date() } },
        { returnDocument: "after" }
      );
      assert.ok(resultA);
      assert.equal(resultA.version, 2);
      assert.equal(resultA.title, "Calculus I - Tab A Edit");

      // Tab B tries to submit update with stale expectedVersion = 1
      const filterB = {
        _id: "mat-race",
        $or: [{ version: tabBExpectedVersion }, { version: { $exists: false } }]
      };
      const resultB = await materialsColl.findOneAndUpdate(
        filterB,
        { $set: { title: "Calculus I - Tab B Overwrite", version: 2, updatedAt: new Date() } },
        { returnDocument: "after" }
      );

      // Tab B update fails (OCC conflict)
      assert.equal(resultB, null);

      // Verify Tab A's edits were preserved
      const finalDoc = await materialsColl.findOne({ _id: "mat-race" });
      assert.equal(finalDoc.title, "Calculus I - Tab A Edit");
      assert.equal(finalDoc.version, 2);
    });
  });

  describe("Checkout Price & Terms Snapshot Isolation", () => {
    test("in-flight checkout quote locks price against concurrent listing edits", async () => {
      const db = createMockDb({
        materials: [
          {
            _id: "mat-checkout",
            materialId: "mat-checkout",
            title: "Physics 101",
            price: 50,
            asset: "XLM",
            version: 1,
            visibility: "public",
            userAddress: "GCREATOR1"
          }
        ]
      });

      // 1. Buyer initiates checkout at price 50
      const quote = await createCheckoutQuote(db, {
        materialId: "mat-checkout",
        buyerAddress: "GBUYER123"
      });

      assert.ok(quote.quoteId);
      assert.equal(quote.terms.price, 50);
      assert.equal(quote.terms.asset, "XLM");
      assert.equal(quote.terms.materialVersion, 1);

      // 2. Creator concurrently edits the listing price to 100 while checkout is in flight
      const materialsColl = db.collection("materials");
      await materialsColl.findOneAndUpdate(
        { _id: "mat-checkout" },
        { $set: { price: 100, version: 2, updatedAt: new Date() } },
        { returnDocument: "after" }
      );

      const modifiedMaterial = await materialsColl.findOne({ _id: "mat-checkout" });
      assert.equal(modifiedMaterial.price, 100);
      assert.equal(modifiedMaterial.version, 2);

      // 3. Buyer completes payment and consumes the quote
      const consumedQuote = await consumeCheckoutQuote(db, {
        quoteId: quote.quoteId,
        materialId: "mat-checkout",
        buyerAddress: "GBUYER123"
      });

      // 4. Verifies the buyer was charged the locked snapshotted price (50), not the new price (100)
      assert.equal(consumedQuote.terms.price, 50);
      assert.equal(consumedQuote.status, "consumed");
    });
  });
});
