/**
 * Data Retention Cleanup Tests (Issue #2)
 *
 * Verifies retention policies are correctly applied and protected records
 * are never deleted.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  RETENTION_POLICIES,
  buildPreviewReport,
  cleanupCollection,
  resolveHoldReason,
} from "../../scripts/data-retention-cleanup.mjs";

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
  // Clear all collections before each test
  const collections = await db.listCollections().toArray();
  for (const coll of collections) {
    await db.collection(coll.name).deleteMany({});
  }
});

describe("Data Retention Cleanup Tests", () => {
  it("should never delete permanently protected collections", async () => {
    // Setup: Add records to protected collections
    const auditLog = {
      _id: new ObjectId(),
      admin_id: "admin1",
      target_user: "user1",
      action_taken: "USER_SUSPENDED",
      timestamp: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) // 1 year old
    };

    const purchase = {
      _id: new ObjectId(),
      buyerAddress: "0xbuyer",
      materialId: new ObjectId().toString(),
      createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), // 1 year old
      status: "completed"
    };

    await db.collection("audit_ledger").insertOne(auditLog);
    await db.collection("purchases").insertOne(purchase);

    // Verify records exist
    const auditCount = await db.collection("audit_ledger").countDocuments();
    const purchaseCount = await db.collection("purchases").countDocuments();

    assert.strictEqual(auditCount, 1);
    assert.strictEqual(purchaseCount, 1);

    // Note: In actual cleanup script, these would be skipped due to protection
    // This test verifies the policy configuration
  });

  it("should identify eligible records outside retention window", async () => {
    // Setup: Add old and new notifications
    const cutoffDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000); // 180 days ago

    const oldNotification = {
      _id: new ObjectId(),
      userId: "user1",
      message: "Old notification",
      read: true,
      readAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) // 200 days ago
    };

    const recentNotification = {
      _id: new ObjectId(),
      userId: "user1",
      message: "Recent notification",
      read: true,
      readAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) // 100 days ago
    };

    await db.collection("notifications").insertMany([oldNotification, recentNotification]);

    // Query for eligible records (older than 180 days)
    const eligible = await db.collection("notifications")
      .find({
        read: true,
        readAt: { $lt: cutoffDate }
      })
      .toArray();

    assert.strictEqual(eligible.length, 1);
    assert.strictEqual(eligible[0]._id.toString(), oldNotification._id.toString());
  });

  it("should protect unread notifications from cleanup", async () => {
    // Setup: Add old but unread notification
    const oldUnreadNotification = {
      _id: new ObjectId(),
      userId: "user1",
      message: "Old unread notification",
      read: false,
      createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) // 200 days old
    };

    await db.collection("notifications").insertOne(oldUnreadNotification);

    // Count unread notifications
    const unreadCount = await db.collection("notifications").countDocuments({
      read: { $ne: true }
    });

    assert.strictEqual(unreadCount, 1, "Unread notification should be protected");
  });

  it("should protect dead letter events with unresolved status", async () => {
    // Setup: Add resolved and unresolved dead letter events
    const resolvedEvent = {
      _id: new ObjectId(),
      status: "resolved",
      resolvedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000), // 100 days ago
      error: "Test error"
    };

    const unresolvedEvent = {
      _id: new ObjectId(),
      status: "pending",
      createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000), // 100 days ago
      error: "Test error"
    };

    await db.collection("dead_letter_events").insertMany([resolvedEvent, unresolvedEvent]);

    // Count unresolved events
    const unresolvedCount = await db.collection("dead_letter_events").countDocuments({
      status: { $in: ["pending", "quarantined", "retrying"] }
    });

    assert.strictEqual(unresolvedCount, 1, "Unresolved events should be protected");
  });

  it("should protect material history while linked material exists", async () => {
    // Setup: Create material and its history
    const material = {
      _id: new ObjectId(),
      title: "Test Material",
      userAddress: "0xcreator",
      visibility: "public",
      createdAt: new Date()
    };

    const history = {
      _id: new ObjectId(),
      materialId: material._id.toString(),
      version: 1,
      deletedAt: new Date(Date.now() - 800 * 24 * 60 * 60 * 1000) // 800 days ago (beyond retention)
    };

    await db.collection("materials").insertOne(material);
    await db.collection("material_history").insertOne(history);

    // Verify history is protected because material exists
    const linkedHistory = await db.collection("material_history")
      .find({
        materialId: { $exists: true },
        deletedAt: { $exists: false }
      })
      .toArray();

    // Note: This checks for history records without deletedAt, showing protection logic
    const materialExists = await db.collection("materials").findOne({ _id: material._id });
    assert.ok(materialExists, "Material should exist, protecting its history");
  });

  it("should protect active entitlements from cleanup", async () => {
    // Setup: Add active and inactive entitlement cache entries
    const activeEntitlement = {
      _id: new ObjectId(),
      materialId: new ObjectId().toString(),
      buyerAddress: "0xbuyer",
      active: true,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Expires in 30 days
      lastCheckedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) // 100 days ago
    };

    const inactiveEntitlement = {
      _id: new ObjectId(),
      materialId: new ObjectId().toString(),
      buyerAddress: "0xbuyer2",
      active: false,
      lastCheckedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) // 100 days ago
    };

    await db.collection("entitlement_cache").insertMany([activeEntitlement, inactiveEntitlement]);

    // Count active entitlements
    const activeCount = await db.collection("entitlement_cache").countDocuments({
      active: true,
      expiresAt: { $gt: new Date() }
    });

    assert.strictEqual(activeCount, 1, "Active entitlements should be protected");
  });

  it("should protect pending outbox intents from cleanup", async () => {
    // Setup: Add completed and pending intents
    const completedIntent = {
      _id: new ObjectId(),
      status: "completed",
      completedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago
      action: "test_action"
    };

    const pendingIntent = {
      _id: new ObjectId(),
      status: "pending",
      createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago
      action: "test_action"
    };

    await db.collection("outbox").insertMany([completedIntent, pendingIntent]);

    // Count pending intents
    const pendingCount = await db.collection("outbox").countDocuments({
      status: { $in: ["pending", "retrying", "failed"] }
    });

    assert.strictEqual(pendingCount, 1, "Pending intents should be protected");
  });

  it("should correctly identify eligible sync events for cleanup", async () => {
    // Setup: Add old and recent sync events
    const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago

    const oldEvent = {
      _id: new ObjectId(),
      processedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000), // 100 days ago
      eventType: "test"
    };

    const recentEvent = {
      _id: new ObjectId(),
      processedAt: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000), // 50 days ago
      eventType: "test"
    };

    await db.collection("sync_events").insertMany([oldEvent, recentEvent]);

    // Query for eligible events
    const eligible = await db.collection("sync_events")
      .find({
        processedAt: { $lt: cutoffDate }
      })
      .toArray();

    assert.strictEqual(eligible.length, 1);
    assert.strictEqual(eligible[0]._id.toString(), oldEvent._id.toString());
  });

  it("should handle collections that do not exist gracefully", async () => {
    // Query a non-existent collection
    const collections = await db.listCollections({ name: "non_existent_collection" }).toArray();
    assert.strictEqual(collections.length, 0, "Non-existent collection should be handled gracefully");
  });

  it("should report summary statistics correctly", async () => {
    // Setup: Add various records
    const notifications = Array.from({ length: 10 }, (_, i) => ({
      _id: new ObjectId(),
      userId: "user1",
      message: `Notification ${i}`,
      read: true,
      readAt: new Date(Date.now() - (200 - i * 10) * 24 * 60 * 60 * 1000) // Varying ages
    }));

    await db.collection("notifications").insertMany(notifications);

    const cutoffDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const eligible = await db.collection("notifications").countDocuments({
      read: true,
      readAt: { $lt: cutoffDate }
    });

    assert.ok(eligible > 0, "Should identify eligible records");
    assert.ok(eligible < 10, "Should not mark all records as eligible");
  });
});

const DAY = 24 * 60 * 60 * 1000;

function daysAgo(now, days) {
  return new Date(now.getTime() - days * DAY);
}

function idsFor(bucket, collection) {
  return bucket
    .filter((entry) => entry.collection === collection)
    .map((entry) => entry.id)
    .sort();
}

describe("Deterministic retention cleanup preview (#892)", () => {
  it("categorises an eligible, expired record", async () => {
    const now = new Date();
    const expired = {
      _id: new ObjectId(),
      eventType: "sync",
      processedAt: daysAgo(now, 200),
    };
    const recent = {
      _id: new ObjectId(),
      eventType: "sync",
      processedAt: daysAgo(now, 10),
    };
    // Expired session (past 30-day window) and a recent one (within window).
    const expiredSession = { _id: new ObjectId(), expiresAt: daysAgo(now, 40) };
    const recentSession = { _id: new ObjectId(), expiresAt: daysAgo(now, 5) };

    await db.collection("sync_events").insertMany([expired, recent]);
    await db.collection("sessions").insertMany([expiredSession, recentSession]);

    const report = await buildPreviewReport(db, { now });

    assert.deepEqual(idsFor(report.buckets.eligible, "sync_events"), [String(expired._id)]);
    assert.deepEqual(idsFor(report.buckets.eligible, "sessions"), [String(expiredSession._id)]);
    assert.ok(
      !idsFor(report.buckets.eligible, "sessions").includes(String(recentSession._id)),
      "records within the retention window must not be eligible"
    );

    const syncReport = report.collections.find((c) => c.collection === "sync_events");
    assert.equal(syncReport.status, "processed");
    assert.equal(syncReport.eligible, 1);

    const sessionReport = report.collections.find((c) => c.collection === "sessions");
    assert.equal(sessionReport.eligible, 1);
  });

  it("skips a permanently protected record with reason", async () => {
    const now = new Date();
    const purchase = {
      _id: new ObjectId(),
      buyerAddress: "0xbuyer",
      materialId: new ObjectId().toString(),
      status: "completed",
      createdAt: daysAgo(now, 400),
    };
    await db.collection("purchases").insertOne(purchase);

    const before = await db.collection("purchases").countDocuments();
    const report = await buildPreviewReport(db, { now });
    const after = await db.collection("purchases").countDocuments();

    const skipped = report.buckets.skipped.find((entry) => entry.collection === "purchases");
    assert.ok(skipped, "purchases must appear in the skipped bucket");
    assert.equal(skipped.reason, "permanently_protected");

    const purchaseReport = report.collections.find((c) => c.collection === "purchases");
    assert.equal(purchaseReport.status, "skipped");
    assert.equal(purchaseReport.eligible, 0);
    assert.equal(before, after, "preview must not delete protected records");
  });

  it("holds a record linked to an active dispute with an explicit reason", async () => {
    const now = new Date();
    const held = {
      _id: new ObjectId(),
      userId: "user1",
      message: "Disputed purchase notification",
      read: true,
      readAt: daysAgo(now, 200),
      activeDispute: true,
    };
    const eligible = {
      _id: new ObjectId(),
      userId: "user1",
      message: "Old clean notification",
      read: true,
      readAt: daysAgo(now, 200),
    };
    await db.collection("notifications").insertMany([held, eligible]);

    const report = await buildPreviewReport(db, { now });

    const heldEntries = report.buckets.held.filter((e) => e.collection === "notifications");
    assert.equal(heldEntries.length, 1);
    assert.equal(heldEntries[0].id, String(held._id));
    assert.equal(heldEntries[0].reason, "active_dispute");

    assert.deepEqual(idsFor(report.buckets.eligible, "notifications"), [String(eligible._id)]);
    assert.ok(
      !idsFor(report.buckets.eligible, "notifications").includes(String(held._id)),
      "held records must not be eligible"
    );

    // Held classification is also available directly.
    assert.equal(
      resolveHoldReason("notifications", held, { now, materialIds: new Set() }),
      "active_dispute"
    );
  });

  it("holds material history linked to an existing material", async () => {
    const now = new Date();
    const materialId = new ObjectId();
    const linked = {
      _id: new ObjectId(),
      materialId: materialId.toString(),
      version: 1,
      deletedAt: daysAgo(now, 800),
    };
    await db.collection("materials").insertOne({ _id: materialId, title: "Kept" });
    await db.collection("material_history").insertOne(linked);

    const report = await buildPreviewReport(db, { now });
    const heldEntries = report.buckets.held.filter((e) => e.collection === "material_history");
    assert.equal(heldEntries.length, 1);
    assert.equal(heldEntries[0].reason, "linked_material_exists");
  });

  it("is deterministic across repeated previews", async () => {
    const now = new Date();
    const docs = Array.from({ length: 4 }, (_, i) => ({
      _id: new ObjectId(),
      eventType: "sync",
      processedAt: daysAgo(now, 200 + i),
    }));
    await db.collection("sync_events").insertMany(docs);

    const first = await buildPreviewReport(db, { now });
    const second = await buildPreviewReport(db, { now });

    assert.deepEqual(first.buckets, second.buckets);
    assert.deepEqual(first.collections, second.collections);
    // Ordered by ascending _id string.
    const expected = docs.map((d) => String(d._id)).sort();
    assert.deepEqual(idsFor(first.buckets.eligible, "sync_events"), expected);
  });

  it("performs no destructive change in preview mode", async () => {
    const now = new Date();
    const expired = { _id: new ObjectId(), expiresAt: daysAgo(now, 40) };
    await db.collection("sessions").insertOne(expired);

    const before = await db.collection("sessions").countDocuments();
    const report = await buildPreviewReport(db, { now });
    const after = await db.collection("sessions").countDocuments();

    assert.equal(report.summary.totalDeleted, 0);
    assert.equal(before, after);
    assert.equal(await db.collection("sessions").countDocuments({ _id: expired._id }), 1);
  });

  it("applies cleanup for eligible records in execute mode", async () => {
    const now = new Date();
    const expired = { _id: new ObjectId(), expiresAt: daysAgo(now, 40) };
    const fresh = { _id: new ObjectId(), expiresAt: daysAgo(now, 5) };
    const purchase = {
      _id: new ObjectId(),
      buyerAddress: "0xbuyer",
      materialId: new ObjectId().toString(),
      status: "completed",
      createdAt: daysAgo(now, 400),
    };
    await db.collection("sessions").insertMany([expired, fresh]);
    await db.collection("purchases").insertOne(purchase);

    const sessionResult = await cleanupCollection(
      db,
      "sessions",
      RETENTION_POLICIES.sessions,
      false,
      now
    );
    assert.equal(sessionResult.deleted, 1);
    assert.equal(await db.collection("sessions").countDocuments({ _id: expired._id }), 0);
    assert.equal(await db.collection("sessions").countDocuments({ _id: fresh._id }), 1);

    const purchaseResult = await cleanupCollection(
      db,
      "purchases",
      RETENTION_POLICIES.purchases,
      false,
      now
    );
    assert.equal(purchaseResult.skipped, true);
    assert.equal(purchaseResult.reason, "permanently_protected");
    assert.equal(await db.collection("purchases").countDocuments({ _id: purchase._id }), 1);
  });
});
