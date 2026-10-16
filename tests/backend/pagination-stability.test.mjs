/**
 * Pagination Stability Tests (Issue #1)
 *
 * Verifies that cursor-based pagination remains stable when records are
 * created, updated, or hidden during pagination.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  buildMarketplaceDiscoveryQuery,
  buildMarketplaceSort,
  encodeMarketplaceCursor,
  decodeMarketplaceCursor,
  buildMarketplaceCursorClause
} from "../../src/lib/backend/marketplaceDiscovery.js";

let mongoServer;
let client;
let db;

before(async () => {
  mongoServer = await MongoMemoryServer.create();
  client = new MongoClient(mongoServer.getUri());
  await client.connect();
  db = client.db("test");
});

after(async () => {
  await client.close();
  await mongoServer.stop();
});

describe("Pagination Stability Tests", () => {
  it("should not duplicate records when new records are inserted mid-pagination", async () => {
    // Setup: Create 30 materials
    const materials = Array.from({ length: 30 }, (_, i) => ({
      _id: new ObjectId(),
      title: `Material ${i}`,
      visibility: "public",
      archived: false,
      moderationStatus: "approved",
      isDeleted: false,
      creatorSuspended: false,
      createdAt: new Date(Date.now() - (30 - i) * 60000), // Chronological order
      price: 10,
      category: "test"
    }));

    await db.collection("material_search_documents").insertMany(materials);

    // Page 1: Get first 10 materials
    const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
    const sort = buildMarketplaceSort("newest");
    const page1 = await db.collection("material_search_documents")
      .find(query)
      .sort(sort)
      .limit(10)
      .toArray();

    assert.strictEqual(page1.length, 10);
    const page1Ids = page1.map(m => m._id.toString());
    const cursor = encodeMarketplaceCursor(page1[page1.length - 1], sort);

    // Simulate concurrent insert: Add 5 new materials at the beginning
    const newMaterials = Array.from({ length: 5 }, (_, i) => ({
      _id: new ObjectId(),
      title: `New Material ${i}`,
      visibility: "public",
      archived: false,
      moderationStatus: "approved",
      isDeleted: false,
      creatorSuspended: false,
      createdAt: new Date(), // Newer than all existing
      price: 10,
      category: "test"
    }));

    await db.collection("material_search_documents").insertMany(newMaterials);

    // Page 2: Get next 10 materials using cursor
    const cursorData = decodeMarketplaceCursor(cursor, sort);
    const cursorClause = buildMarketplaceCursorClause(cursorData, sort);
    const page2Query = { ...query, $and: [cursorClause] };

    const page2 = await db.collection("material_search_documents")
      .find(page2Query)
      .sort(sort)
      .limit(10)
      .toArray();

    // Verify: No duplicates between page 1 and page 2
    const page2Ids = page2.map(m => m._id.toString());
    const intersection = page1Ids.filter(id => page2Ids.includes(id));

    assert.strictEqual(intersection.length, 0, "Pages should not contain duplicate records");
  });

  it("should not skip records when records are deleted mid-pagination", async () => {
    // Setup: Create 30 materials
    await db.collection("material_search_documents").deleteMany({});
    const materials = Array.from({ length: 30 }, (_, i) => ({
      _id: new ObjectId(),
      title: `Material ${i}`,
      visibility: "public",
      archived: false,
      moderationStatus: "approved",
      isDeleted: false,
      creatorSuspended: false,
      createdAt: new Date(Date.now() - (30 - i) * 60000),
      price: 10,
      category: "test"
    }));

    await db.collection("material_search_documents").insertMany(materials);

    // Page 1: Get first 10 materials
    const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
    const sort = buildMarketplaceSort("newest");
    const page1 = await db.collection("material_search_documents")
      .find(query)
      .sort(sort)
      .limit(10)
      .toArray();

    const cursor = encodeMarketplaceCursor(page1[page1.length - 1], sort);
    const allInitialIds = materials.map(m => m._id.toString());

    // Simulate concurrent delete: Remove 5 materials from positions 5-9
    const toDelete = materials.slice(5, 10).map(m => m._id);
    await db.collection("material_search_documents").deleteMany({
      _id: { $in: toDelete }
    });

    // Page 2: Get next 10 materials using cursor
    const cursorData = decodeMarketplaceCursor(cursor, sort);
    const cursorClause = buildMarketplaceCursorClause(cursorData, sort);
    const page2Query = { ...query, $and: [cursorClause] };

    const page2 = await db.collection("material_search_documents")
      .find(page2Query)
      .sort(sort)
      .limit(10)
      .toArray();

    // Get all remaining records in order
    const allRemaining = await db.collection("material_search_documents")
      .find(query)
      .sort(sort)
      .toArray();

    const page1And2Ids = [...page1, ...page2].map(m => m._id.toString());

    // Verify: First 15 remaining records should match page1+page2 (excluding deleted)
    const expectedIds = allRemaining.slice(0, 15).map(m => m._id.toString());
    assert.deepStrictEqual(page1And2Ids.slice(0, expectedIds.length), expectedIds.slice(0, page1And2Ids.length));
  });

  it("should maintain deterministic ordering with identical sort values", async () => {
    // Setup: Create materials with identical createdAt timestamps
    await db.collection("material_search_documents").deleteMany({});
    const sameTimestamp = new Date();
    const materials = Array.from({ length: 20 }, (_, i) => ({
      _id: new ObjectId(),
      title: `Material ${i}`,
      visibility: "public",
      archived: false,
      moderationStatus: "approved",
      isDeleted: false,
      creatorSuspended: false,
      createdAt: sameTimestamp, // All have same timestamp
      price: 10,
      category: "test"
    }));

    await db.collection("material_search_documents").insertMany(materials);

    // Fetch twice and verify order is identical
    const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
    const sort = buildMarketplaceSort("newest");

    const fetch1 = await db.collection("material_search_documents")
      .find(query)
      .sort(sort)
      .toArray();

    const fetch2 = await db.collection("material_search_documents")
      .find(query)
      .sort(sort)
      .toArray();

    const ids1 = fetch1.map(m => m._id.toString());
    const ids2 = fetch2.map(m => m._id.toString());

    assert.deepStrictEqual(ids1, ids2, "Order must be deterministic with identical sort values");
  });

  it("should consistently exclude hidden, deleted, and suspended records", async () => {
    // Setup: Create materials with various states
    await db.collection("material_search_documents").deleteMany({});
    const materials = [
      { _id: new ObjectId(), title: "Public", visibility: "public", archived: false, moderationStatus: "approved", isDeleted: false, creatorSuspended: false, createdAt: new Date(), price: 10 },
      { _id: new ObjectId(), title: "Archived", visibility: "public", archived: true, moderationStatus: "approved", isDeleted: false, creatorSuspended: false, createdAt: new Date(), price: 10 },
      { _id: new ObjectId(), title: "Suspended", visibility: "public", archived: false, moderationStatus: "suspended", isDeleted: false, creatorSuspended: false, createdAt: new Date(), price: 10 },
      { _id: new ObjectId(), title: "Deleted", visibility: "public", archived: false, moderationStatus: "approved", isDeleted: true, creatorSuspended: false, createdAt: new Date(), price: 10 },
      { _id: new ObjectId(), title: "Creator Suspended", visibility: "public", archived: false, moderationStatus: "approved", isDeleted: false, creatorSuspended: true, createdAt: new Date(), price: 10 },
      { _id: new ObjectId(), title: "Public 2", visibility: "public", archived: false, moderationStatus: "approved", isDeleted: false, creatorSuspended: false, createdAt: new Date(), price: 10 }
    ];

    await db.collection("material_search_documents").insertMany(materials);

    // Query with catalog filters
    const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
    const results = await db.collection("material_search_documents")
      .find(query)
      .toArray();

    // Should only return the two "Public" materials
    assert.strictEqual(results.length, 2);
    assert.ok(results.every(m => m.title.includes("Public")));
  });

  it("should handle cursor pagination across different sort patterns", async () => {
    // Setup: Create materials with varying prices and ratings
    await db.collection("material_search_documents").deleteMany({});
    const materials = Array.from({ length: 20 }, (_, i) => ({
      _id: new ObjectId(),
      title: `Material ${i}`,
      visibility: "public",
      archived: false,
      moderationStatus: "approved",
      isDeleted: false,
      creatorSuspended: false,
      createdAt: new Date(Date.now() - i * 60000),
      price: 10 + (i % 5) * 5,
      rating: 3 + (i % 3),
      likes: i * 10,
      category: "test"
    }));

    await db.collection("material_search_documents").insertMany(materials);

    const sortPatterns = ["newest", "price_asc", "price_desc", "rating", "popular"];

    for (const sortBy of sortPatterns) {
      const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
      const sort = buildMarketplaceSort(sortBy);

      // Get page 1
      const page1 = await db.collection("material_search_documents")
        .find(query)
        .sort(sort)
        .limit(10)
        .toArray();

      const cursor = encodeMarketplaceCursor(page1[page1.length - 1], sort);

      // Get page 2
      const cursorData = decodeMarketplaceCursor(cursor, sort);
      const cursorClause = buildMarketplaceCursorClause(cursorData, sort);
      const page2Query = { ...query, $and: [cursorClause] };

      const page2 = await db.collection("material_search_documents")
        .find(page2Query)
        .sort(sort)
        .limit(10)
        .toArray();

      // Verify no duplicates
      const page1Ids = page1.map(m => m._id.toString());
      const page2Ids = page2.map(m => m._id.toString());
      const intersection = page1Ids.filter(id => page2Ids.includes(id));

      assert.strictEqual(intersection.length, 0, `No duplicates for sortBy=${sortBy}`);
    }
  });
});
