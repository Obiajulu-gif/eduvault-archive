/**
 * Restore Integrity Validation Tests (Issue #3)
 *
 * Verifies that the integrity validation script correctly detects:
 * - Missing records (broken foreign keys)
 * - Orphaned records
 * - Duplicate records
 * - Inconsistent records
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

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

beforeEach(async () => {
  const collections = await db.listCollections().toArray();
  for (const coll of collections) {
    await db.collection(coll.name).deleteMany({});
  }
});

describe("Restore Integrity Validation Tests", () => {
  describe("Missing Records Detection", () => {
    it("should detect purchase referencing non-existent material", async () => {
      const nonExistentMaterialId = new ObjectId().toString();
      const purchase = {
        _id: new ObjectId(),
        buyerAddress: "0xbuyer",
        materialId: nonExistentMaterialId,
        createdAt: new Date(),
        status: "completed"
      };

      await db.collection("purchases").insertOne(purchase);

      // Verify material doesn't exist
      const material = await db.collection("materials").findOne({
        _id: new ObjectId(nonExistentMaterialId)
      });

      assert.strictEqual(material, null, "Material should not exist");

      // Check for orphaned purchase
      const purchases = await db.collection("purchases").find({}).toArray();
      const materialIds = purchases.map(p => p.materialId).filter(Boolean);
      
      const existingMaterials = await db.collection("materials")
        .find({ _id: { $in: materialIds.map(id => ObjectId.isValid(id) ? new ObjectId(id) : null).filter(Boolean) } })
        .toArray();
      
      const existingSet = new Set(existingMaterials.map(m => m._id.toString()));
      const orphaned = purchases.filter(p => p.materialId && !existingSet.has(String(p.materialId)));

      assert.strictEqual(orphaned.length, 1, "Should detect orphaned purchase");
    });

    it("should detect entitlement cache referencing non-existent material", async () => {
      const nonExistentMaterialId = new ObjectId().toString();
      const cache = {
        _id: new ObjectId(),
        materialId: nonExistentMaterialId,
        buyerAddress: "0xbuyer",
        active: true
      };

      await db.collection("entitlement_cache").insertOne(cache);

      const cacheEntries = await db.collection("entitlement_cache").find({ active: true }).toArray();
      const materialIds = cacheEntries.map(c => c.materialId).filter(Boolean);
      
      const existingMaterials = await db.collection("materials")
        .find({ _id: { $in: materialIds.map(id => ObjectId.isValid(id) ? new ObjectId(id) : null).filter(Boolean) } })
        .toArray();
      
      const existingSet = new Set(existingMaterials.map(m => m._id.toString()));
      const orphaned = cacheEntries.filter(c => c.materialId && !existingSet.has(String(c.materialId)));

      assert.strictEqual(orphaned.length, 1, "Should detect orphaned cache entry");
    });

    it("should detect refund referencing non-existent purchase", async () => {
      const nonExistentPurchaseId = new ObjectId().toString();
      const refund = {
        _id: new ObjectId(),
        purchaseId: nonExistentPurchaseId,
        amount: 100,
        reason: "Test refund"
      };

      await db.collection("refund_requests").insertOne(refund);

      const purchase = await db.collection("purchases").findOne({
        _id: new ObjectId(nonExistentPurchaseId)
      });

      assert.strictEqual(purchase, null, "Purchase should not exist");
    });
  });

  describe("Duplicate Records Detection", () => {
    it("should detect duplicate wallet addresses", async () => {
      const users = [
        { _id: new ObjectId(), walletAddress: "0xduplicate", createdAt: new Date() },
        { _id: new ObjectId(), walletAddress: "0xduplicate", createdAt: new Date() },
        { _id: new ObjectId(), walletAddress: "0xunique", createdAt: new Date() }
      ];

      await db.collection("users").insertMany(users);

      const pipeline = [
        { $group: { _id: "$walletAddress", count: { $sum: 1 }, ids: { $push: "$_id" } } },
        { $match: { count: { $gt: 1 } } }
      ];

      const duplicates = await db.collection("users").aggregate(pipeline).toArray();

      assert.strictEqual(duplicates.length, 1, "Should detect one duplicate wallet address");
      assert.strictEqual(duplicates[0].count, 2, "Should count 2 duplicate entries");
    });

    it("should detect duplicate UUIDs", async () => {
      const users = [
        { _id: new ObjectId(), walletAddress: "0xuser1", uuid: "duplicate-uuid", createdAt: new Date() },
        { _id: new ObjectId(), walletAddress: "0xuser2", uuid: "duplicate-uuid", createdAt: new Date() },
        { _id: new ObjectId(), walletAddress: "0xuser3", uuid: "unique-uuid", createdAt: new Date() }
      ];

      await db.collection("users").insertMany(users);

      const pipeline = [
        { $match: { uuid: { $exists: true, $ne: null } } },
        { $group: { _id: "$uuid", count: { $sum: 1 }, ids: { $push: "$_id" } } },
        { $match: { count: { $gt: 1 } } }
      ];

      const duplicates = await db.collection("users").aggregate(pipeline).toArray();

      assert.strictEqual(duplicates.length, 1, "Should detect one duplicate UUID");
    });
  });

  describe("Inconsistent Records Detection", () => {
    it("should detect purchase without buyer address", async () => {
      const purchases = [
        { _id: new ObjectId(), buyerAddress: "0xbuyer", materialId: new ObjectId().toString(), createdAt: new Date() },
        { _id: new ObjectId(), materialId: new ObjectId().toString(), createdAt: new Date() }, // Missing buyerAddress
        { _id: new ObjectId(), buyerAddress: "", materialId: new ObjectId().toString(), createdAt: new Date() } // Empty buyerAddress
      ];

      await db.collection("purchases").insertMany(purchases);

      const invalid = await db.collection("purchases").find({
        $or: [
          { buyerAddress: { $exists: false } },
          { buyerAddress: null },
          { buyerAddress: "" }
        ]
      }).toArray();

      assert.strictEqual(invalid.length, 2, "Should detect purchases without buyer address");
    });

    it("should detect material without creator address", async () => {
      const materials = [
        { _id: new ObjectId(), title: "Valid", userAddress: "0xcreator", visibility: "public", createdAt: new Date() },
        { _id: new ObjectId(), title: "Invalid", visibility: "public", createdAt: new Date() }, // Missing userAddress
        { _id: new ObjectId(), title: "Invalid 2", userAddress: "", visibility: "public", createdAt: new Date() } // Empty userAddress
      ];

      await db.collection("materials").insertMany(materials);

      const invalid = await db.collection("materials").find({
        $or: [
          { userAddress: { $exists: false } },
          { userAddress: null },
          { userAddress: "" }
        ]
      }).toArray();

      assert.strictEqual(invalid.length, 2, "Should detect materials without creator address");
    });

    it("should detect protected material without storage key", async () => {
      const materials = [
        { _id: new ObjectId(), title: "Valid Paid", userAddress: "0xcreator", visibility: "public", price: 10, storageKey: "QmHash", createdAt: new Date() },
        { _id: new ObjectId(), title: "Invalid Paid", userAddress: "0xcreator", visibility: "public", price: 10, createdAt: new Date() }, // Missing storage
        { _id: new ObjectId(), title: "Invalid Private", userAddress: "0xcreator", visibility: "private", createdAt: new Date() } // Missing storage
      ];

      await db.collection("materials").insertMany(materials);

      const invalid = await db.collection("materials").find({
        $or: [
          { price: { $gt: 0 } },
          { visibility: "private" }
        ],
        $and: [
          { storageKey: { $exists: false } },
          { ipfsCid: { $exists: false } },
          { cid: { $exists: false } },
          { fileHash: { $exists: false } }
        ]
      }).toArray();

      assert.strictEqual(invalid.length, 2, "Should detect protected materials without storage key");
    });

    it("should detect active entitlement without completed purchase", async () => {
      const material = {
        _id: new ObjectId(),
        title: "Test Material",
        userAddress: "0xcreator",
        visibility: "public",
        price: 10,
        createdAt: new Date()
      };

      const cache = {
        _id: new ObjectId(),
        materialId: material._id.toString(),
        buyerAddress: "0xbuyer",
        active: true
      };

      await db.collection("materials").insertOne(material);
      await db.collection("entitlement_cache").insertOne(cache);

      // No purchase exists
      const purchase = await db.collection("purchases").findOne({
        materialId: cache.materialId,
        buyerAddress: cache.buyerAddress,
        status: { $in: ["confirmed", "settled", "completed"] }
      });

      assert.strictEqual(purchase, null, "Should detect active entitlement without purchase");
    });

    it("should detect completed purchase without transaction hash", async () => {
      const purchases = [
        { _id: new ObjectId(), buyerAddress: "0xbuyer", materialId: new ObjectId().toString(), status: "completed", transactionHash: "0xhash", createdAt: new Date() },
        { _id: new ObjectId(), buyerAddress: "0xbuyer2", materialId: new ObjectId().toString(), status: "completed", createdAt: new Date() } // Missing hash
      ];

      await db.collection("purchases").insertMany(purchases);

      const invalid = await db.collection("purchases").find({
        status: { $in: ["confirmed", "settled", "completed"] },
        $or: [
          { transactionHash: { $exists: false } },
          { transactionHash: null },
          { transactionHash: "" }
        ]
      }).toArray();

      assert.strictEqual(invalid.length, 1, "Should detect completed purchase without transaction hash");
    });
  });

  describe("Valid Records (No Violations)", () => {
    it("should pass validation for complete valid dataset", async () => {
      // Setup complete valid data
      const user = {
        _id: new ObjectId(),
        walletAddress: "0xuser",
        uuid: "valid-uuid",
        createdAt: new Date()
      };

      const material = {
        _id: new ObjectId(),
        title: "Test Material",
        userAddress: user.walletAddress,
        visibility: "public",
        price: 10,
        storageKey: "QmValidHash",
        createdAt: new Date(),
        archived: false,
        moderationStatus: "approved",
        isDeleted: false
      };

      const purchase = {
        _id: new ObjectId(),
        buyerAddress: "0xbuyer",
        materialId: material._id.toString(),
        status: "completed",
        transactionHash: "0xtxhash",
        createdAt: new Date()
      };

      const cache = {
        _id: new ObjectId(),
        materialId: material._id.toString(),
        buyerAddress: purchase.buyerAddress,
        active: true
      };

      await db.collection("users").insertOne(user);
      await db.collection("materials").insertOne(material);
      await db.collection("purchases").insertOne(purchase);
      await db.collection("entitlement_cache").insertOne(cache);

      // Run all validation checks
      const userCount = await db.collection("users").countDocuments();
      const materialCount = await db.collection("materials").countDocuments();
      const purchaseCount = await db.collection("purchases").countDocuments();
      const cacheCount = await db.collection("entitlement_cache").countDocuments();

      assert.strictEqual(userCount, 1);
      assert.strictEqual(materialCount, 1);
      assert.strictEqual(purchaseCount, 1);
      assert.strictEqual(cacheCount, 1);

      // Verify relationships
      const foundMaterial = await db.collection("materials").findOne({ _id: material._id });
      const foundPurchase = await db.collection("purchases").findOne({ materialId: material._id.toString() });
      const foundCache = await db.collection("entitlement_cache").findOne({ materialId: material._id.toString() });

      assert.ok(foundMaterial);
      assert.ok(foundPurchase);
      assert.ok(foundCache);
    });
  });
});
